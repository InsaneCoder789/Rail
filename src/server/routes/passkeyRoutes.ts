import type http from "node:http";
import type { ServerContext } from "../types.js";
import { RequestError, applyRateLimit, applyIdentityRateLimit, json, requireJsonContentType, readAndParseJson } from "../http.js";

const ACTIONS: Readonly<Record<string, "registrationOptions" | "register" | "authenticationOptions" | "authenticate" | "rotateRecoveryCodes" | "revokePasskey" | "recover">> = {
  "/auth/passkeys/register/options": "registrationOptions", "/auth/passkeys/register/verify": "register",
  "/auth/passkeys/step-up/options": "authenticationOptions", "/auth/passkeys/step-up/verify": "authenticate",
  "/auth/passkeys/recovery-codes/rotate": "rotateRecoveryCodes", "/auth/passkeys/revoke": "revokePasskey", "/auth/passkeys/recover": "recover",
};

export async function handlePasskeyRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: ServerContext): Promise<boolean> {
  const action = req.method === "POST" ? ACTIONS[url.pathname] : undefined;
  const listing = req.method === "GET" && url.pathname === "/auth/passkeys";
  if (!action && !listing) return false;
  res.setHeader("Cache-Control", "no-store");
  await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "owner_passkey_source", limit: 60, windowMs: 300000,
    trustProxyHeaders: context.config.trustProxyHeaders });
  if (!context.authResolver.resolveOwnerPrincipal) throw new RequestError(401, "owner_authentication_required", "owner authentication required");
  const principal = await context.authResolver.resolveOwnerPrincipal(req);
  await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "owner_passkey_identity", identity: principal.walletId, limit: 30, windowMs: 300000 });
  if (action === "recover") await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "owner_recovery_attempts", identity: principal.walletId, limit: 5, windowMs: 900000 });
  if (!context.ownerPasskeys) throw new RequestError(503, "passkeys_unavailable", "passkeys are not configured");
  if (listing) json(res, 200, { passkeys: await context.ownerPasskeys.list(principal) });
  else {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const body = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    json(res, 200, await context.ownerPasskeys[action!](principal, body));
  }
  return true;
}
