import http from "node:http";
import { RequestError, applyRateLimit, json, resolveAllowedOrigin } from "../http.js";
import type { ServerContext, ServerEvent } from "../types.js";

export async function handleEventRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  const stream = url.pathname === "/v1/events/stream";
  if (req.method !== "GET" || (!stream && url.pathname !== "/v1/events")) return false;
  if (stream && context.config.disableSse) {
    json(res, 501, { error: "event_stream_unavailable", hint: "use GET /v1/events for hosted serverless runtimes" });
    return true;
  }
  const viewer = { walletId: await context.authResolver.resolveAuthenticatedWallet(req) };
  await applyRateLimit({ req, res, rateLimiter: context.rateLimiter,
    scope: stream ? "events_stream" : "events_read", discriminator: viewer.walletId,
    limit: stream ? 6 : 60, windowMs: 60_000, trustProxyHeaders: context.config.trustProxyHeaders });

  if (!stream) {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    const events = await context.eventStore.listVisibleEvents(viewer, limit, url.searchParams.get("before") ?? undefined);
    json(res, 200, { events, nextBefore: events.length === limit ? events.at(-1)?.id ?? null : null });
    return true;
  }

  const client = { res, viewer };
  if (!context.eventStore.addSseClient(client)) throw new RequestError(429, "event_stream_capacity", "too many active event streams");
  let stopped = false;
  let polling = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(deadline);
    context.eventStore.removeSseClient(client);
    res.removeListener("close", cleanup);
    res.removeListener("error", stop);
  };
  const stop = () => { cleanup(); res.end(); };
  const write = (data: string): boolean => {
    if (stopped) return false;
    if (!res.write(data)) { stop(); return false; }
    return true;
  };
  const send = (events: ServerEvent[]) => {
    for (const event of events.reverse()) {
      if (!event.id || seen.has(event.id)) continue;
      if (seen.size >= 3000 || !write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) { stop(); return; }
      seen.add(event.id);
    }
  };
  res.once("close", cleanup);
  res.once("error", stop);
  try {
    // Fetch before sending headers so initial database errors remain normal JSON errors.
    const recent = await context.eventStore.listVisibleEvents(viewer, 100);
    if (stopped || res.destroyed) { cleanup(); return true; }
    const allowedOrigin = resolveAllowedOrigin(req, context.config.allowedOrigins);
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
    });
    if (!write(": connected; advisory snapshots, reconcile with GET /v1/events\n\n")) return true;
    send(recent);
    if (stopped) return true;
    // Poll committed shared rows, not process-local broadcasts. Recheck credentials
    // every poll and cap lifetime; this is a UI hint stream, not a delivery receipt.
    interval = setInterval(() => {
      if (stopped || polling) return;
      polling = true;
      void (async () => {
        if (await context.authResolver.resolveAuthenticatedWallet(req) !== viewer.walletId) throw new Error("event_viewer_changed");
        const events = await context.eventStore.listVisibleEvents(viewer, 100);
        if (stopped) return;
        send(events);
        write(": keep-alive\n\n");
      })().catch(() => { stop(); }).finally(() => { polling = false; });
    }, 2000);
    deadline = setTimeout(stop, 60_000);
    interval.unref();
    deadline.unref();
  } catch (error) {
    if (res.headersSent) stop();
    else { cleanup(); throw error; }
  }
  return true;
}
