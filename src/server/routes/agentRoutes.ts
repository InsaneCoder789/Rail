import type http from "node:http";
import { RequestError, applyRateLimit, applyIdentityRateLimit, json, readAndParseJson, requireJsonContentType } from "../http.js";
import type { ServerContext } from "../types.js";

export async function handleAgentRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: ServerContext): Promise<boolean> {
  const execution = req.method === "POST" ? /^\/v2\/agent\/intents\/([^/]+)\/execute$/.exec(url.pathname) : null;
  if (((req.method === "GET" || req.method === "POST") && url.pathname === "/v2/agent/intents") || execution) {
    await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "agent_requests", limit: 30, windowMs: 60_000,
      trustProxyHeaders: context.config.trustProxyHeaders });
    const header = req.headers.authorization;
    const token = typeof header === "string" ? /^Bearer (rail_agent_[A-Za-z0-9_-]{43})$/.exec(header)?.[1] : undefined;
    const identity = await context.agentStore.resolveCredential(token);
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "agent_intents",
      identity: identity.agentId, limit: 20, windowMs: 60_000 });
    if (req.method === "GET") json(res, 200, { intents: await context.agentStore.listAgentIntents(token) });
    else {
      if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
      const body = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
      if (execution) json(res, 200, await context.agentStore.executeIntent(token, execution[1], body));
      else json(res, 200, { intent: await context.agentStore.createIntent(token, body) });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/v2/agent/identity") {
    await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "agent_identity", limit: 30, windowMs: 60_000,
      trustProxyHeaders: context.config.trustProxyHeaders });
    const header = req.headers.authorization;
    const token = typeof header === "string" ? /^Bearer (rail_agent_[A-Za-z0-9_-]{43})$/.exec(header)?.[1] : undefined;
    const identity = await context.agentStore.resolveCredential(token);
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "agent_identity",
      identity: identity.agentId, limit: 30, windowMs: 60_000 });
    json(res, 200, { identity });
    return true;
  }

  const root = url.pathname === "/v2/agents";
  const route = /^\/v2\/agents\/([^/]+)\/(revoke|credentials|mandates|intents)(?:\/([^/]+)\/(revoke|decision))?$/.exec(url.pathname);
  if ((!root && !route) || (req.method !== "GET" && req.method !== "POST")) return false;
  if (route && ((route[2] === "revoke" && req.method !== "POST") || (route[3] && req.method !== "POST") || (route[2] === "revoke" && route[3]))) return false;
  if (route && ((route[2] === "intents" && (route[4] === "revoke" || (req.method === "POST" && !route[3]))) ||
    (route[2] !== "intents" && route[4] === "decision"))) return false;

  await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "agent_control_source", limit: 30,
    windowMs: 60_000, trustProxyHeaders: context.config.trustProxyHeaders });
  const owner = await context.authResolver.resolveOwnerWallet(req);
  await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "agent_control",
    identity: owner, limit: 20, windowMs: 60_000 });
  if (req.method === "GET") {
    if (root) json(res, 200, { agents: await context.agentStore.listAgents(owner) });
    else if (route![2] === "credentials") json(res, 200, { credentials: await context.agentStore.listCredentials(owner, route![1]) });
    else if (route![2] === "intents") json(res, 200, { intents: await context.agentStore.listIntents(owner, route![1]) });
    else json(res, 200, { mandates: await context.agentStore.listMandates(owner, route![1]) });
    return true;
  }

  if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
  const body = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
  if (root) json(res, 201, { agent: await context.agentStore.createAgent(owner, body) });
  else {
    const [, agentId, action, resourceId] = route!;
    if (action === "revoke") json(res, 200, { agent: await context.agentStore.revokeAgent(owner, agentId) });
    else if (action === "intents") json(res, 200, { intent: await context.agentStore.decideIntent(owner, agentId, resourceId, body) });
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
