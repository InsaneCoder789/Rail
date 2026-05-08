import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { verifyToken } from "../auth/jwt.js";
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

function resolveBearerTokenFromUrl(url: URL): string | undefined {
  const token = url.searchParams.get("access_token");
  return token && token.length > 0 ? token : undefined;
}

function resolveApiKeyFromUrl(url: URL): string | undefined {
  const key = url.searchParams.get("api_key");
  return key && key.length > 0 ? key : undefined;
}

async function getWalletFromApiKey(pool: Pool, apiKey: string): Promise<string> {
  const res = await pool.query(
    `SELECT wallet_id FROM api_keys WHERE api_key = $1`,
    [apiKey],
  );

  if (res.rowCount === 0) {
    throw new Error("INVALID_API_KEY");
  }

  return res.rows[0].wallet_id as string;
}

async function getWalletFromUser(pool: Pool, userId: string): Promise<string> {
  const res = await pool.query(
    `SELECT wallet_id FROM users WHERE user_id = $1`,
    [userId],
  );

  if (res.rowCount === 0) {
    throw new Error("USER_NOT_FOUND");
  }

  return res.rows[0].wallet_id as string;
}

export function createAuthResolver(args: {
  getPool: () => Pool | null;
  apiKey: string;
}): AuthResolver {
  return {
    async resolveAuthenticatedWallet(req, url, options) {
      const pool = args.getPool();
      if (!pool) {
        throw new Error("DB_NOT_INITIALIZED");
      }

      const bearer = resolveBearerToken(req) ?? (options?.allowQueryCredentials && url ? resolveBearerTokenFromUrl(url) : undefined);
      if (bearer) {
        const decoded = verifyToken(bearer);
        return getWalletFromUser(pool, decoded.userId);
      }

      const apiKey = resolveApiKeyHeader(req) ?? (options?.allowQueryCredentials && url ? resolveApiKeyFromUrl(url) : undefined);
      if (apiKey) {
        return getWalletFromApiKey(pool, apiKey);
      }

      throw new RequestError(401, "unauthorized", "missing auth");
    },

    requireApiKey(req, res) {
      if (!args.apiKey) {
        json(res, 503, {
          error: "server_misconfig",
          message: "RAIL_API_KEY is required for this route",
        });
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
