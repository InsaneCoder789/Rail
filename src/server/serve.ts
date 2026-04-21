import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import process from "node:process";
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
import { OfflineTokenStore, type IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import { processSyncBatch } from "../rail/syncBatch.js";

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
    offlineTokenId:
      parsed.channel === "online" ? undefined : typeof parsed.offlineTokenId === "string" ? parsed.offlineTokenId : undefined,
    deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
    paymentSignature: typeof parsed.paymentSignature === "string" ? parsed.paymentSignature : undefined,
  };
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
    await runMigrations(pool);
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

  const server = http.createServer(async (req, res) => {
    try {
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
        if (!requireApiKey(req, res)) return;
        if (!requireJsonContentType(req, res)) return;

        const parsed = await readAndParseJson(req);

        if (!isPaymentTransaction(parsed)) {
          json(res, 422, { error: "invalid_body", hint: "expected PaymentTransaction fields" });
          return;
        }

        const txn = toPaymentTransaction(parsed);
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

      json(res, 404, { error: "not_found" });
    } catch (err) {
      if (!(err instanceof RequestError)) {
        // eslint-disable-next-line no-console
        console.error("request_failed", err);
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
