import http from "node:http";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { generateToken, verifyToken, InvalidTokenError } from "../../auth/jwt.js";
import { RequestError, applyRateLimit, applyIdentityRateLimit, json, readAndParseJson, requireJsonContentType } from "../http.js";
import type { ServerContext } from "../types.js";
import { isSafeText, isRecord } from "../validation.js";

export async function handleAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  const scope = req.method === "POST" ? ({ "/auth/register": "register", "/auth/login": "login",
    "/auth/logout-all": "logout_all" } as Record<string, string>)[url.pathname] : undefined;
  if (scope) await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope,
    limit: context.config.rateLimits.loginMax, windowMs: context.config.rateLimits.loginWindowMs,
    trustProxyHeaders: context.config.trustProxyHeaders });
  if (req.method === "POST" && url.pathname === "/auth/register") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isRecord(parsed)) throw new RequestError(422, "invalid_body", "expected object body");
    const body = parsed;

    if (!context.pool) {
      throw new Error("DB_NOT_INITIALIZED");
    }
    if (!body.userId || !body.password) {
      throw new RequestError(422, "invalid_body", "userId and password required");
    }
    if (!isSafeText(body.userId, 3, 128)) {
      throw new RequestError(422, "invalid_body", "userId is invalid");
    }
    if (typeof body.password !== "string" || body.password.length < 8 || Buffer.byteLength(body.password, "utf8") > 72) {
      throw new RequestError(422, "weak_password", "password must contain at least 8 characters and at most 72 UTF-8 bytes");
    }

    const hash = await bcrypt.hash(body.password, 10);
    const client = await context.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const wallet = await client.query(
        `INSERT INTO wallets (wallet_id, balance, reserved)
         VALUES ($1, 0, 0)
         ON CONFLICT (wallet_id) DO NOTHING`,
        [body.userId],
      );
      if (wallet.rowCount !== 1) {
        throw new RequestError(409, "wallet_exists", "registration cannot claim an existing wallet");
      }
      await client.query(
        `INSERT INTO users (user_id, password_hash, wallet_id)
         VALUES ($1, $2, $1)`,
        [body.userId, hash],
      );
      await client.query("COMMIT");
    } catch (err: unknown) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      const pgError = err as { code?: string };
      if (pgError?.code === "23505") {
        throw new RequestError(409, "user_exists", "user already exists");
      }
      throw err;
    } finally {
      client.release(discard);
      client.removeListener("error", onError);
    }

    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isRecord(parsed)) throw new RequestError(422, "invalid_body", "expected object body");
    const body = parsed;

    if (!context.pool) {
      throw new Error("DB_NOT_INITIALIZED");
    }

    if (!isSafeText(body.userId, 3, 128) || typeof body.password !== "string" ||
        body.password.length < 8 || Buffer.byteLength(body.password, "utf8") > 72) {
      throw new RequestError(422, "invalid_body", "invalid login credentials");
    }

    // No IP component: rotating source addresses cannot bypass this account quota.
    // Hash the identifier to avoid placing usernames in rate-limit bucket keys.
    const account = createHash("sha256").update(body.userId).digest("hex");
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "login_account", identity: account,
      limit: context.config.rateLimits.loginMax, windowMs: context.config.rateLimits.loginWindowMs });
    const resDb = await context.pool.query(
      `SELECT password_hash, auth_version, wallet_id FROM users WHERE user_id = $1`,
      [body.userId],
    );

    if (resDb.rowCount === 0) {
      throw new RequestError(401, "invalid_credentials", "invalid credentials");
    }

    const valid = await bcrypt.compare(String(body.password ?? ""), resDb.rows[0].password_hash as string);
    if (!valid) {
      throw new RequestError(401, "invalid_credentials", "invalid credentials");
    }

    const token = generateToken(body.userId, resDb.rows[0].auth_version);
    json(res, 200, { token, walletId: resDb.rows[0].wallet_id });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout-all") {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new RequestError(401, "unauthorized", "bearer token required");
    if (!context.pool) throw new Error("DB_NOT_INITIALIZED");
    let credentials;
    try { credentials = verifyToken(header.slice(7)); }
    catch (error) {
      if (error instanceof InvalidTokenError) throw new RequestError(401, "invalid_credentials", "invalid credentials");
      throw error;
    }
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "logout_all",
      identity: createHash("sha256").update(credentials.userId).digest("hex"),
      limit: context.config.rateLimits.loginMax, windowMs: context.config.rateLimits.loginWindowMs });
    const result = await context.pool.query(`UPDATE users SET auth_version = auth_version + 1
      WHERE user_id = $1 AND auth_version = $2 AND auth_version < 2147483647 RETURNING user_id`,
      [credentials.userId, credentials.authVersion]);
    if (result.rowCount !== 1) throw new RequestError(401, "invalid_credentials", "invalid credentials");
    json(res, 200, { ok: true, sessionsRevoked: "all" });
    return true;
  }

  return false;
}
