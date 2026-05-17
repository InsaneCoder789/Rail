import http from "node:http";
import { applyCors, json, resolveAllowedOrigin, toErrorResponse } from "../http.js";
import type { ServerContext } from "../types.js";

export async function handleEventRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/events/stream") {
    const viewer = {
      walletId: await context.authResolver.resolveAuthenticatedWallet(req, url, { allowQueryCredentials: true }),
    };

    const allowedOrigin = resolveAllowedOrigin(req, context.config.allowedOrigins);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
    });

    res.write(": connected\n\n");

    const client = { res, viewer };
    context.eventStore.addSseClient(client);
    void (async () => {
      const recent = await context.eventStore.listVisibleEvents(viewer, 50);
      for (const evt of recent.reverse()) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    })();

    const interval = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        clearInterval(interval);
        context.eventStore.removeSseClient(client);
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(interval);
      context.eventStore.removeSseClient(client);
    });

    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/events") {
    try {
      applyCors(req, res, context.config.allowedOrigins);
      const viewer = {
        walletId: await context.authResolver.resolveAuthenticatedWallet(req, url, { allowQueryCredentials: true }),
      };
      const events = await context.eventStore.listVisibleEvents(viewer, 20);
      json(res, 200, { events });
    } catch (err) {
      const mapped = toErrorResponse(err, context.config.exposeInternalErrors);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  return false;
}
