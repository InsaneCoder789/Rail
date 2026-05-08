import http from "node:http";
import * as bcrypt from "bcryptjs";
import { generateToken } from "../../auth/jwt.js";
import { RequestError, applyRateLimit, json, readAndParseJson, requireJsonContentType } from "../http.js";
import type { ServerContext } from "../types.js";
import { isSafeText } from "../validation.js";

export async function handleAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/auth/register") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);
    const body = parsed as Record<string, unknown>;
    applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "register",
      limit: context.config.rateLimits.loginMax,
      windowMs: context.config.rateLimits.loginWindowMs,
      discriminator: String(body?.userId ?? ""),
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
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
      throw new RequestError(422, "weak_password", "password must be 8-128 characters");
    }

    const hash = await bcrypt.hash(body.password, 10);
    const client = await context.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO wallets (wallet_id, balance, reserved)
         VALUES ($1, 0, 0)
         ON CONFLICT (wallet_id) DO NOTHING`,
        [body.userId],
      );
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
    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);
    const body = parsed as Record<string, unknown>;
    applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "login",
      limit: context.config.rateLimits.loginMax,
      windowMs: context.config.rateLimits.loginWindowMs,
      discriminator: String(body?.userId ?? ""),
    });

    if (!context.pool) {
      throw new Error("DB_NOT_INITIALIZED");
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
