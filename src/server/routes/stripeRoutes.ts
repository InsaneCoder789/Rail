import type http from "node:http";
import type { ServerContext } from "../types.js";
import { applyRateLimit, json, readRequestBody, requireJsonContentType, RequestError } from "../http.js";

export async function handleStripeRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: ServerContext): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/v2/providers/stripe/webhook" || !context.stripeCallbacks) return false;
  res.setHeader("Cache-Control", "no-store");
  if (url.search) throw new RequestError(400, "invalid_stripe_webhook", "webhook query parameters are not accepted");
  await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "stripe_webhook_source", limit: 60,
    windowMs: 60000, trustProxyHeaders: context.config.trustProxyHeaders });
  if (!requireJsonContentType(req, res, true)) return true;
  const body = await readRequestBody(req, Math.min(context.config.maxRequestBodyBytes, 262144), context.config.requestBodyTimeoutMs);
  json(res, 200, await context.stripeCallbacks.accept(body, req.headers["stripe-signature"]));
  return true;
}
