import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { verifyToken, InvalidTokenError } from "../auth/jwt.js";
import { RequestError, json, normalizeHeaderValue } from "./http.js";
import type { AuthResolver } from "./types.js";

function secureEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function resolveApiKeyHeader(req: http.IncomingMessage): string | undefined {
  const h = req.headers;
  const v =
    h["x-rail-api-key"] ??
    h["X-Rail-Api-Key"] ??
    h["x-kylr-api-key"] ??
    h["X-Kylr-Api-Key"];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function resolveBearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h) return undefined;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  const parts = v.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return undefined;
}

async function getWalletFromApiKey(pool: Pool, apiKey: string): Promise<string> {
  const apiKeyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
  const res = await pool.query(
    `SELECT wallet_id FROM api_keys WHERE api_key_hash = $1`,
    [apiKeyHash],
  );

  if (res.rowCount === 0) {
    throw new RequestError(401, "invalid_credentials", "invalid credentials");
  }

  return res.rows[0].wallet_id as string;
}

async function getWalletFromUser(pool: Pool, userId: string, authVersion: number): Promise<string> {
  const res = await pool.query(
    `SELECT wallet_id FROM users WHERE user_id = $1 AND auth_version = $2`,
    [userId, authVersion],
  );

  if (res.rowCount === 0) {
    throw new RequestError(401, "invalid_credentials", "invalid credentials");
  }

  return res.rows[0].wallet_id as string;
}

export function createAuthResolver(args: {
  getPool: () => Pool | null;
  apiKey: string;
  apiKeyScopes: readonly string[];
}): AuthResolver {
  return {
    async resolveAuthenticatedWallet(req, url, options) {
      const pool = args.getPool();
      if (!pool) {
        throw new Error("DB_NOT_INITIALIZED");
      }

      const bearer = resolveBearerToken(req);
      if (bearer) {
        try {
          const decoded = verifyToken(bearer);
          return await getWalletFromUser(pool, decoded.userId, decoded.authVersion);
        } catch (err) {
          if (err instanceof InvalidTokenError) throw new RequestError(401, "invalid_credentials", "invalid credentials");
          throw err;
        }
      }

      const apiKey = resolveApiKeyHeader(req);
      if (apiKey) {
        return getWalletFromApiKey(pool, apiKey);
      }

      throw new RequestError(401, "unauthorized", "missing auth");
    },

    requireApiKey(req, res, scope) {
      if (!args.apiKey) {
        json(res, 503, {
          error: "server_misconfig",
          message: "RAIL_API_KEY is required for this route",
        });
        return false;
      }
      if (scope && !args.apiKeyScopes.includes(scope)) {
        json(res, 403, { error: "api_key_scope_denied" });
        return false;
      }
      const provided = resolveApiKeyHeader(req);
      if (!provided || !secureEquals(provided, args.apiKey)) {
        json(res, 401, { error: "unauthorized" });
        return false;
      }
      return true;
    },
  };
}
