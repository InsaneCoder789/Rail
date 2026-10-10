import http from "node:http";
import * as bcrypt from "bcryptjs";
import { generateToken } from "../../auth/jwt.js";
import { RequestError, applyRateLimit, json, readAndParseJson, requireJsonContentType } from "../http.js";
import type { ServerContext } from "../types.js";
import { isSafeText, isRecord } from "../validation.js";

export async function handleAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/auth/register") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isRecord(parsed)) throw new RequestError(422, "invalid_body", "expected object body");
    const body = parsed;
    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "register",
      limit: context.config.rateLimits.loginMax,
      windowMs: context.config.rateLimits.loginWindowMs,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

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
    try {
      await client.query("BEGIN");
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
      await client.query("ROLLBACK");
      const pgError = err as { code?: string };
      if (pgError?.code === "23505") {
        throw new RequestError(409, "user_exists", "user already exists");
      }
      throw err;
    } finally {
      client.release();
    }

    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isRecord(parsed)) throw new RequestError(422, "invalid_body", "expected object body");
    const body = parsed;
    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "login",
      limit: context.config.rateLimits.loginMax,
      windowMs: context.config.rateLimits.loginWindowMs,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

    if (!context.pool) {
      throw new Error("DB_NOT_INITIALIZED");
    }

    if (!isSafeText(body.userId, 3, 128) || typeof body.password !== "string" ||
        body.password.length < 8 || Buffer.byteLength(body.password, "utf8") > 72) {
      throw new RequestError(422, "invalid_body", "invalid login credentials");
    }

    const resDb = await context.pool.query(
      `SELECT password_hash FROM users WHERE user_id = $1`,
      [body.userId],
    );

    if (resDb.rowCount === 0) {
      throw new RequestError(401, "invalid_credentials", "invalid credentials");
    }

    const valid = await bcrypt.compare(String(body.password ?? ""), resDb.rows[0].password_hash as string);
    if (!valid) {
      throw new RequestError(401, "invalid_credentials", "invalid credentials");
    }

    const token = generateToken(String(body.userId));
    json(res, 200, { token });
    return true;
  }

  return false;
}
