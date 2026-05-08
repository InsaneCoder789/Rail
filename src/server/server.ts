import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: join(__dirname, "../../.env") });
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import process from "node:process";

import * as bcrypt from "bcryptjs";
import type { PaymentAuthorization } from "../domain/authorization.js";
import { generateToken, verifyToken } from "../auth/jwt.js";
import type { PaymentTransaction } from "../domain/types.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { MemoryIdempotencyStore } from "../pipeline/idempotency.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { PostgresOfflineTokenStore } from "../persistence/postgresOfflineTokenStore.js";
import { createPool } from "../persistence/postgresPool.js";
import { runMigrations } from "../persistence/migrate.js";
import { MemoryOutbox } from "../pipeline/outbox.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../stages/paymentPipeline.js";
import { initLedger } from "../stages/paymentPipeline.js";
import { OfflineTokenStore, type IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import { processSyncBatch } from "../rail/syncBatch.js";
import { createAuthorization, getAuthorizationById, initAuthorizationWallet, releaseExpiredAuthorizations } from "../stages/authorizationStage.js";

const tracer = consoleTracer("[rail]");
const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.RAIL_API_KEY ?? process.env.KYLR_API_KEY ?? "";
const MAX_REQUEST_BODY_BYTES = resolvePositiveIntEnv("RAIL_MAX_REQUEST_BODY_BYTES", 64 * 1024);
const MAX_SYNC_BATCH_SIZE = resolvePositiveIntEnv("RAIL_MAX_SYNC_BATCH_SIZE", 100);
const EXPOSE_INTERNAL_ERRORS = process.env.RAIL_EXPOSE_INTERNAL_ERRORS === "true";
const REQUIRE_JSON_CONTENT_TYPE = process.env.RAIL_REQUIRE_JSON_CONTENT_TYPE !== "false";

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_AMOUNT_MINOR = 1_000_000_000_000;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const OFFLINE_CHANNELS = new Set<PaymentTransaction["channel"]>(["nfc", "ble", "qr"]);
const AUTHORIZATION_SWEEP_INTERVAL_MS = resolvePositiveIntEnv("RAIL_AUTH_SWEEP_INTERVAL_MS", 60_000);

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  readonly exposeMessage: boolean;

  constructor(status: number, code: string, message: string, hint?: string, exposeMessage = true) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.exposeMessage = exposeMessage;
  }
}

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

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

// --- API key to wallet binding helper ---
let globalPool: any = null;

// 🔥 Simple in-memory outbox (used if DB not initialized)
const outboxEvents: any[] = [];
const sseClients = new Set<http.ServerResponse>();

// 🔥 TEMP FIX: capture pipeline logs and forward to SSE + DB
const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
  originalConsoleLog(...args);

  try {
    // capture outbox_relay logs
    if (args[0] === "outbox_relay" && args[1] && typeof args[1] === "object") {
      const evt = args[1];

      const normalizedEvent = {
        type: evt.type ?? "unknown",
        payload: evt.payload ?? {},
        occurredAt: evt.occurredAt ?? new Date().toISOString(),
      };

      broadcastEvent(normalizedEvent);
      insertOutboxEvent(normalizedEvent).catch(() => {});
    }
  } catch (e) {
    originalConsoleLog("log_intercept_error", e);
  }
};

function broadcastEvent(event: any) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Postgres Outbox Helpers ---
async function insertOutboxEvent(event: {
  type: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}): Promise<void> {
  if (!event || typeof event !== "object") return;

  const finalEvent = {
    type: event.type ?? "unknown",
    payload: event.payload ?? {},
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };

  if (!globalPool) {
    outboxEvents.unshift(finalEvent);
    if (outboxEvents.length > 20) outboxEvents.pop();

    broadcastEvent(finalEvent);
    return;
  }

  try {
    await globalPool.query(
      `INSERT INTO outbox (type, payload, occurred_at)
       VALUES ($1, $2::jsonb, $3::timestamptz)`,
      [finalEvent.type, JSON.stringify(finalEvent.payload), finalEvent.occurredAt]
    );
  } catch (e) {
    console.error("outbox_db_error", e);
  }

  broadcastEvent(finalEvent);
}

// --- Global helper to emit system errors to SSE + DB ---
function emitSystemError(err: any, stage?: string, txId?: string) {
  const normalized = {
    type: "system.error",
    payload: {
      name: err?.name ?? "Error",
      message: err?.message ?? "Unknown error",
      stage: stage ?? null,
      txId: txId ?? null,
    },
    occurredAt: new Date().toISOString(),
  };

  broadcastEvent(normalized);
  insertOutboxEvent(normalized).catch(() => {});
}

async function listOutboxEvents(limit = 20): Promise<any[]> {
  if (!globalPool) {
    return outboxEvents;
  }

  const res = await globalPool.query(
    `SELECT type, payload, occurred_at
     FROM outbox
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit]
  );

  return res.rows.map((r: any) => ({
    type: r.type,
    payload: r.payload,
    occurredAt: r.occurred_at,
  }));
}

async function getWalletFromApiKey(apiKey: string): Promise<string> {
  if (!globalPool) {
    throw new Error("DB_NOT_INITIALIZED");
  }

  const res = await globalPool.query(
    `SELECT wallet_id FROM api_keys WHERE api_key = $1`,
    [apiKey]
  );

  if (res.rowCount === 0) {
    throw new Error("INVALID_API_KEY");
  }

  return res.rows[0].wallet_id;
}

// get wallet from JWT (users table)
async function getWalletFromUser(userId: string): Promise<string> {
  if (!globalPool) throw new Error("DB_NOT_INITIALIZED");
  const res = await globalPool.query(
    `SELECT wallet_id FROM users WHERE user_id = $1`,
    [userId]
  );
  if (res.rowCount === 0) throw new Error("USER_NOT_FOUND");
  return res.rows[0].wallet_id;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let finished = false;

    const rejectOnce = (err: unknown): void => {
      if (finished) return;
      finished = true;
      reject(err);
    };

    const resolveOnce = (value: string): void => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectOnce(
          new RequestError(
            413,
            "payload_too_large",
            `request body exceeded ${maxBytes} bytes`,
            "reduce payload size or increase RAIL_MAX_REQUEST_BODY_BYTES",
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveOnce(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => rejectOnce(err));
  });
}

function requireApiKey(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!API_KEY) return true;
  const provided = resolveApiKeyHeader(req);
  if (!provided || !secureEquals(provided, API_KEY)) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}
function requireJsonContentType(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!REQUIRE_JSON_CONTENT_TYPE) return true;
  const contentType = normalizeHeaderValue(req.headers["content-type"]);
  const normalized = contentType?.toLowerCase().split(";")[0].trim();
  if (normalized === "application/json") {
    return true;
  }
  json(res, 415, {
    error: "unsupported_media_type",
    hint: "set Content-Type: application/json",
  });
  return false;
}

function isSafeText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length < min || value.length > max) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  return true;
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_RE.test(value);
}

function isValidAmountMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_MINOR;
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isValidChannel(value: unknown): value is PaymentTransaction["channel"] {
  return value === "nfc" || value === "ble" || value === "qr" || value === "online";
}

function isOptionalBase64(value: unknown, maxLength: number): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.length < 16 || value.length > maxLength) return false;
  return BASE64_RE.test(value);
}

function isPaymentTransaction(x: unknown): x is PaymentTransaction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (!isSafeText(o.txId, 8, 128)) return false;
  if (!isSafeText(o.idempotencyKey, 8, 128)) return false;
  if (o.authorizationId !== undefined && !isSafeText(o.authorizationId, 8, 128)) return false;
  if (!isSafeText(o.senderWalletId, 3, 128)) return false;
  if (!isSafeText(o.receiverWalletId, 3, 128)) return false;
  if (!isValidAmountMinor(o.amountMinor)) return false;
  if (!isCurrency(o.currency)) return false;
  if (!isValidChannel(o.channel)) return false;
  if (!isValidIsoTimestamp(o.createdAt)) return false;
  if (o.deviceId !== undefined && !isSafeText(o.deviceId, 3, 128)) return false;
  if (o.offlineTokenId !== undefined && !isSafeText(o.offlineTokenId, 8, 128)) return false;
  if (!isOptionalBase64(o.paymentSignature, 4096)) return false;

  if (OFFLINE_CHANNELS.has(o.channel)) {
    if (!isSafeText(o.offlineTokenId, 8, 128)) return false;
    if (!isSafeText(o.deviceId, 3, 128)) return false;
    return true;
  }

  if (o.offlineTokenId !== undefined) {
    return false;
  }

  return true;
}

function toPaymentTransaction(parsed: PaymentTransaction): PaymentTransaction {
  return {
    ...parsed,
    authorizationId: typeof parsed.authorizationId === "string" ? parsed.authorizationId : undefined,
    offlineTokenId:
      parsed.channel === "online" ? undefined : typeof parsed.offlineTokenId === "string" ? parsed.offlineTokenId : undefined,
    deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
    paymentSignature: typeof parsed.paymentSignature === "string" ? parsed.paymentSignature : undefined,
  };
}

function resolveAuthorizationReference(body: Record<string, unknown>): {
  authorizationId?: string;
  providedAuthorization?: PaymentAuthorization;
} {
  const explicitId = typeof body.authorizationId === "string" ? body.authorizationId : undefined;
  const rawAuthorization = body.authorization;
  const providedAuthorization =
    rawAuthorization && typeof rawAuthorization === "object"
      ? (rawAuthorization as PaymentAuthorization)
      : undefined;
  const embeddedId = providedAuthorization?.authId;

  if (explicitId && embeddedId && explicitId !== embeddedId) {
    throw new RequestError(
      422,
      "authorization_reference_mismatch",
      "authorizationId does not match authorization.authId",
    );
  }

  return {
    authorizationId: explicitId ?? embeddedId,
    providedAuthorization,
  };
}

function assertAuthorizationMatchesTransaction(auth: PaymentAuthorization, txn: PaymentTransaction): void {
  if (
    auth.txId !== txn.txId ||
    auth.amountMinor !== txn.amountMinor ||
    auth.currency !== txn.currency ||
    auth.senderWalletId !== txn.senderWalletId ||
    auth.receiverWalletId !== txn.receiverWalletId
  ) {
    throw new RequestError(
      401,
      "auth_txn_mismatch",
      "authorization does not match transaction",
    );
  }
}

function assertStoredAuthorizationUsable(auth: { status: string; expiresAt: string }): void {
  if (auth.status !== "issued") {
    throw new RequestError(409, "authorization_not_issued", `authorization status is ${auth.status}`);
  }
  if (Date.parse(auth.expiresAt) <= Date.now()) {
    throw new RequestError(409, "authorization_expired", "authorization has expired");
  }
}

function isIssueTokenRequest(x: unknown): x is {
  walletId: string;
  deviceId: string;
  amountCapMinor: number;
  currency?: string;
  ttlSeconds?: number;
} {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    isSafeText(o.walletId, 3, 128) &&
    isSafeText(o.deviceId, 3, 128) &&
    isValidAmountMinor(o.amountCapMinor) &&
    (o.currency === undefined || isCurrency(o.currency)) &&
    (o.ttlSeconds === undefined ||
      (typeof o.ttlSeconds === "number" &&
        Number.isSafeInteger(o.ttlSeconds) &&
        o.ttlSeconds >= MIN_TTL_SECONDS &&
        o.ttlSeconds <= MAX_TTL_SECONDS))
  );
}

function isSyncBody(x: unknown): x is { deviceId: string; transactions: unknown[] } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    isSafeText(o.deviceId, 3, 128) &&
    Array.isArray(o.transactions) &&
    o.transactions.length > 0 &&
    o.transactions.length <= MAX_SYNC_BATCH_SIZE
  );
}

function toErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof RequestError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.hint) body.hint = err.hint;
    if (EXPOSE_INTERNAL_ERRORS || err.exposeMessage) {
      body.message = err.message;
    }
    return { status: err.status, body };
  }
  if (EXPOSE_INTERNAL_ERRORS) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "internal_error", message } };
  }
  return { status: 500, body: { error: "internal_error" } };
}

async function readAndParseJson(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new RequestError(400, "invalid_json", "request body is not valid JSON");
  }
}

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  let offlineTokenStore: IOfflineTokenStore;
  let idempotency: MemoryIdempotencyStore | PostgresIdempotencyStore;

  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    globalPool = pool;
    await runMigrations(pool);

    // ensure outbox table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id BIGSERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // create index for faster reads
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_occurred_at_desc
      ON outbox (occurred_at DESC);
    `);

    // initialize wallet + ledger systems
    initAuthorizationWallet(pool);
    const releasedCount = await releaseExpiredAuthorizations().catch((err) => {
      console.error("authorization_sweep_failed", err);
      return 0;
    });
    if (releasedCount > 0) {
      console.log(`Rail: released ${releasedCount} expired authorization reservations`);
    }
    setInterval(() => {
      void releaseExpiredAuthorizations().catch((err) => {
        console.error("authorization_sweep_failed", err);
      });
    }, AUTHORIZATION_SWEEP_INTERVAL_MS).unref();

    // initialize ledger (new)
    initLedger(pool);
    offlineTokenStore = new PostgresOfflineTokenStore(pool);
    idempotency = new PostgresIdempotencyStore(pool);
    // eslint-disable-next-line no-console
    console.log("Rail: PostgreSQL persistence enabled (DATABASE_URL)");
  } else {
    offlineTokenStore = new OfflineTokenStore();
    idempotency = new MemoryIdempotencyStore();
    // eslint-disable-next-line no-console
    console.warn("Rail: DATABASE_URL not set — using in-memory idempotency + offline tokens (dev only)");
  }

  const engine = new PaymentPipelineEngine({
    idempotency,
    outbox: new MemoryOutbox(),
    tracer,
    dlq: new MemoryDeadLetterQueue(),
    pipeline: buildHardenedPaymentPipeline(tracer, offlineTokenStore),
  });

  // 🔥 CRITICAL: Forward pipeline outbox events → DB + SSE
  // access internal outbox (engine keeps it private)
  const outboxAny = (engine as any).outbox;

  if (outboxAny && typeof outboxAny.append === "function" && !outboxAny.__forwardingEnabled) {
    const originalAppend = outboxAny.append.bind(outboxAny);

    outboxAny.append = (event: any) => {
      try {
        // keep engine internal behavior
        originalAppend(event);

        // 🔥 Normalize event (CRITICAL FIX)
        const normalizedEvent = {
          type: event.type ?? "unknown",
          payload: event.payload ?? {},
          occurredAt: event.occurredAt ?? new Date().toISOString(),
        };

        // 🔥 stream immediately
        broadcastEvent(normalizedEvent);

        // 🔥 persist correctly
        insertOutboxEvent(normalizedEvent).catch((err) =>
          console.error("outbox_forward_error", err)
        );
      } catch (err) {
        console.error("outbox_patch_error", err);
      }
    };
    outboxAny.__forwardingEnabled = true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // --- CORS ---
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (!req.url || !req.method) {
        json(res, 400, { error: "bad_request" });
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: "rail",
          persistence: databaseUrl ? "postgresql" : "memory",
          offline: {
            tokenIssue: "POST /v1/offline/tokens/issue",
            execute: "POST /v1/payments/execute",
            sync: "POST /v1/sync/transactions",
          },
        });
        return;
      }

      // 🔐 Register
      if (req.method === "POST" && url.pathname === "/auth/register") {
        if (!requireJsonContentType(req, res)) return;
        const parsed = await readAndParseJson(req);
        const body = parsed as any;

        if (!body.userId || !body.password) {
          throw new RequestError(422, "invalid_body", "userId and password required");
        }

        const hash = await bcrypt.hash(body.password, 10);

        // create wallet if not exists
        await globalPool.query(
          `INSERT INTO wallets (wallet_id, balance, reserved)
           VALUES ($1, 0, 0)
           ON CONFLICT (wallet_id) DO NOTHING`,
          [body.userId]
        );

        await globalPool.query(
          `INSERT INTO users (user_id, password_hash, wallet_id)
           VALUES ($1, $2, $1)`,
          [body.userId, hash]
        );

        json(res, 200, { ok: true });
        return;
      }

      // 🔐 Login
      if (req.method === "POST" && url.pathname === "/auth/login") {
        if (!requireJsonContentType(req, res)) return;
        const parsed = await readAndParseJson(req);
        const body = parsed as any;

        const resDb = await globalPool.query(
          `SELECT password_hash FROM users WHERE user_id = $1`,
          [body.userId]
        );

        if (resDb.rowCount === 0) {
          throw new RequestError(401, "invalid_credentials", "user not found");
        }

        const valid = await bcrypt.compare(body.password, resDb.rows[0].password_hash);
        if (!valid) {
          throw new RequestError(401, "invalid_credentials", "wrong password");
        }

        const token = generateToken(body.userId);
        json(res, 200, { token });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/payments/authorize") {
        if (!requireJsonContentType(req, res)) return;

        const parsed = await readAndParseJson(req);

        // --- Enforce API key or JWT → wallet binding ---
        let walletFromKey: string | null = null;
        const bearer = resolveBearerToken(req);
        if (bearer) {
          let decoded;
          try {
            decoded = verifyToken(bearer);
          } catch (err: any) {
            emitSystemError(err, "auth.verify");
            throw err;
          }
          walletFromKey = await getWalletFromUser(decoded.userId);
        } else {
          const apiKey = resolveApiKeyHeader(req);
          if (!apiKey) {
            throw new RequestError(401, "unauthorized", "missing auth");
          }
          walletFromKey = await getWalletFromApiKey(apiKey);
        }

        if (!parsed || typeof parsed !== "object") {
          throw new RequestError(422, "invalid_body", "expected object body");
        }

        const o = parsed as Record<string, unknown>;

        if (
          !isSafeText(o.txId, 8, 128) ||
          !isSafeText(o.senderWalletId, 3, 128) ||
          !isSafeText(o.receiverWalletId, 3, 128) ||
          !isValidAmountMinor(o.amountMinor) ||
          !isCurrency(o.currency)
        ) {
          throw new RequestError(
            422,
            "invalid_body",
            "invalid authorization request",
            "txId, senderWalletId, receiverWalletId, amountMinor, currency required"
          );
        }

        // --- Enforce identity binding ---
        if (o.senderWalletId !== walletFromKey) {
          throw new RequestError(403, "identity_mismatch", "sender does not match auth");
        }

        const auth = await createAuthorization({
          txId: o.txId as string,
          senderWalletId: o.senderWalletId as string,
          receiverWalletId: o.receiverWalletId as string,
          amountMinor: o.amountMinor as number,
          currency: o.currency as string,
        });

        json(res, 200, { authorization: auth });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/offline/tokens/issue") {
        if (!requireApiKey(req, res)) return;
        if (!requireJsonContentType(req, res)) return;

        const parsed = await readAndParseJson(req);

        if (!isIssueTokenRequest(parsed)) {
          json(res, 422, {
            error: "invalid_body",
            hint: "walletId, deviceId, amountCapMinor required",
          });
          return;
        }

        const row = await offlineTokenStore.issue({
          walletId: parsed.walletId,
          deviceId: parsed.deviceId,
          amountCapMinor: parsed.amountCapMinor,
          currency: parsed.currency,
          ttlSeconds: parsed.ttlSeconds,
        });

        json(res, 200, {
          token: {
            tokenId: row.tokenId,
            walletId: row.walletId,
            deviceId: row.deviceId,
            amountCapMinor: row.amountCapMinor,
            remainingMinor: row.remainingMinor,
            currency: row.currency,
            issuedAtMs: row.issuedAtMs,
            expiresAtMs: row.expiresAtMs,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/payments/execute") {
        if (!requireJsonContentType(req, res)) return;

        const parsed = await readAndParseJson(req);

        // --- Enforce API key or JWT → wallet binding ---
        let walletFromKey: string | null = null;
        const bearer = resolveBearerToken(req);
        if (bearer) {
          let decoded;
          try {
            decoded = verifyToken(bearer);
          } catch (err: any) {
            emitSystemError(err, "auth.verify");
            throw err;
          }
          walletFromKey = await getWalletFromUser(decoded.userId);
        } else {
          const apiKey = resolveApiKeyHeader(req);
          if (!apiKey) {
            throw new RequestError(401, "unauthorized", "missing auth");
          }
          walletFromKey = await getWalletFromApiKey(apiKey);
        }

        const body = parsed as Record<string, unknown>;
        const { authorizationId, providedAuthorization } = resolveAuthorizationReference(body);
        if (!authorizationId) {
          throw new RequestError(401, "authorization_required", "missing authorization");
        }

        const storedAuthorization = await getAuthorizationById(authorizationId);
        if (!storedAuthorization) {
          throw new RequestError(404, "authorization_not_found", "authorization not found");
        }
        assertStoredAuthorizationUsable(storedAuthorization);

        const { authorization: _auth, ...txnRaw } = body;

        if (!isPaymentTransaction(txnRaw)) {
          json(res, 422, { error: "invalid_body", hint: "expected PaymentTransaction fields" });
          return;
        }

        const txn = toPaymentTransaction({
          ...(txnRaw as PaymentTransaction),
          authorizationId,
        });

        // --- Enforce identity binding ---
        if (txn.senderWalletId !== walletFromKey) {
          throw new RequestError(403, "identity_mismatch", "sender does not match auth");
        }

        assertAuthorizationMatchesTransaction(storedAuthorization, txn);
        if (providedAuthorization) {
          assertAuthorizationMatchesTransaction(providedAuthorization, txn);
          if (providedAuthorization.signature !== storedAuthorization.signature) {
            throw new RequestError(
              401,
              "authorization_signature_mismatch",
              "authorization signature does not match stored authorization",
            );
          }
        }

        const result = await engine.execute(txn);

        json(res, 200, { result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sync/transactions") {
        if (!requireApiKey(req, res)) return;
        if (!requireJsonContentType(req, res)) return;
        const parsed = await readAndParseJson(req);

        if (!isSyncBody(parsed)) {
          json(res, 422, {
            error: "invalid_body",
            hint: `deviceId and transactions[] required (1-${MAX_SYNC_BATCH_SIZE} items)`,
          });
          return;
        }

        const txns: PaymentTransaction[] = [];
        for (const item of parsed.transactions) {
          if (!isPaymentTransaction(item)) {
            json(res, 422, { error: "invalid_transaction_in_batch" });
            return;
          }
          const txn = toPaymentTransaction(item);
          if (txn.channel !== "online" && txn.deviceId !== parsed.deviceId) {
            json(res, 422, {
              error: "device_mismatch_in_batch",
              hint: "offline transactions must use same deviceId as sync request",
            });
            return;
          }
          if (txn.channel === "online" && txn.deviceId !== undefined && txn.deviceId !== parsed.deviceId) {
            json(res, 422, {
              error: "device_mismatch_in_batch",
              hint: "transaction.deviceId must match sync deviceId when provided",
            });
            return;
          }
          txns.push(txn);
        }

        const results = await processSyncBatch(engine, txns);
        json(res, 200, { deviceId: parsed.deviceId, results });
        return;
      }

      // 📡 Live event stream (SSE)
if (req.method === "GET" && url.pathname === "/v1/events/stream") {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  res.write(": connected\n\n");

  sseClients.add(res);
  (async () => {
    const recent = await listOutboxEvents(50);
    for (const evt of recent.reverse()) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
  })();

  const interval = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      clearInterval(interval);
      sseClients.delete(res);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(interval);
    sseClients.delete(res);
  });

  return;
}

      

      // 📡 Events endpoint (Postgres-backed outbox)
      if (req.method === "GET" && url.pathname === "/v1/events") {
        try {
          const events = await listOutboxEvents(20);
          json(res, 200, { events });
        } catch (e) {
          json(res, 500, { error: "internal_error" });
        }
        return;
      }

      json(res, 200, { status: "success" });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("request_failed", err);

      // 🔥 emit to SSE
      emitSystemError(err);
      if (err instanceof RequestError) {
        emitSystemError({
          name: err.code,
          message: err.message,
        });
      }

      const mapped = toErrorResponse(err);
      json(res, mapped.status, mapped.body);
    }
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Rail listening on http://0.0.0.0:${PORT}`);
    if (API_KEY) {
      // eslint-disable-next-line no-console
      console.log("API key authentication: enabled (RAIL_API_KEY or KYLR_API_KEY)");
    } else {
      // eslint-disable-next-line no-console
      console.warn("API key authentication: disabled (set RAIL_API_KEY in production)");
    }
    // eslint-disable-next-line no-console
    console.log(`Request body limit: ${MAX_REQUEST_BODY_BYTES} bytes`);
  });
}

void bootstrap();
