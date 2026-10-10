import type http from "node:http";
import { RequestError, RateLimitError, applyRateLimit, json, readAndParseJson, requireJsonContentType } from "../http.js";
import type { ServerContext } from "../types.js";

export async function handleAgentRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: ServerContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v2/agent/identity") {
    await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "agent_identity", limit: 30, windowMs: 60_000,
      trustProxyHeaders: context.config.trustProxyHeaders });
    const header = req.headers.authorization;
    const token = typeof header === "string" ? /^Bearer (rail_agent_[A-Za-z0-9_-]{43})$/.exec(header)?.[1] : undefined;
    json(res, 200, { identity: await context.agentStore.resolveCredential(token) });
    return true;
  }

  const root = url.pathname === "/v2/agents";
  const route = /^\/v2\/agents\/([^/]+)\/(revoke|credentials|mandates)(?:\/([^/]+)\/revoke)?$/.exec(url.pathname);
  if ((!root && !route) || (req.method !== "GET" && req.method !== "POST")) return false;
  if (route && ((route[2] === "revoke" && req.method !== "POST") || (route[3] && req.method !== "POST") || (route[2] === "revoke" && route[3]))) return false;

  const owner = await context.authResolver.resolveOwnerWallet(req);
  // Owner-global bucket deliberately has no caller-supplied agent ID or IP component.
  const quota = await context.rateLimiter.consume(`agent-control:owner:${owner}`, 20, 60_000);
  res.setHeader("X-RateLimit-Limit", String(quota.limit));
  res.setHeader("X-RateLimit-Remaining", String(quota.remaining));
  if (quota.retryAfterSeconds > 0) throw new RateLimitError("agent control rate limit exceeded", quota.retryAfterSeconds, quota.limit, quota.remaining);
  if (req.method === "GET") {
    if (root) json(res, 200, { agents: await context.agentStore.listAgents(owner) });
    else if (route![2] === "credentials") json(res, 200, { credentials: await context.agentStore.listCredentials(owner, route![1]) });
    else json(res, 200, { mandates: await context.agentStore.listMandates(owner, route![1]) });
    return true;
  }

  if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
  const body = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
  if (root) json(res, 201, { agent: await context.agentStore.createAgent(owner, body) });
  else {
    const [, agentId, action, resourceId] = route!;
    if (action === "revoke") json(res, 200, { agent: await context.agentStore.revokeAgent(owner, agentId) });
    else if (action === "credentials") {
      if (resourceId) json(res, 200, { credential: await context.agentStore.revokeCredential(owner, agentId, resourceId) });
      else json(res, 201, { credential: await context.agentStore.issueCredential(owner, agentId, body) });
    } else if (action === "mandates") {
      if (resourceId) json(res, 200, { mandate: await context.agentStore.revokeMandate(owner, agentId, resourceId) });
      else json(res, 201, { mandate: await context.agentStore.createMandate(owner, agentId, body) });
    } else throw new RequestError(404, "not_found", "route not found");
  }
  return true;
}
