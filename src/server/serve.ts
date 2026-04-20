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
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function requireApiKey(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!API_KEY) return true;
  const provided = resolveApiKeyHeader(req);
  if (provided !== API_KEY) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function isPaymentTransaction(x: unknown): x is PaymentTransaction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.deviceId !== undefined && typeof o.deviceId !== "string") return false;
  if (o.paymentSignature !== undefined && typeof o.paymentSignature !== "string") return false;
  return (
    typeof o.txId === "string" &&
    typeof o.idempotencyKey === "string" &&
    typeof o.senderWalletId === "string" &&
    typeof o.receiverWalletId === "string" &&
    typeof o.amountMinor === "number" &&
    typeof o.currency === "string" &&
    typeof o.channel === "string" &&
    typeof o.createdAt === "string"
  );
}

function toPaymentTransaction(parsed: PaymentTransaction): PaymentTransaction {
  return {
    ...parsed,
    offlineTokenId: typeof parsed.offlineTokenId === "string" ? parsed.offlineTokenId : undefined,
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
    typeof o.walletId === "string" &&
    typeof o.deviceId === "string" &&
    typeof o.amountCapMinor === "number" &&
    o.amountCapMinor > 0 &&
    (o.currency === undefined || typeof o.currency === "string") &&
    (o.ttlSeconds === undefined || typeof o.ttlSeconds === "number")
  );
}

function isSyncBody(x: unknown): x is { deviceId: string; transactions: unknown[] } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.deviceId === "string" && Array.isArray(o.transactions);
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

        const raw = await readJsonBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }

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

        const raw = await readJsonBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }

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

        const raw = await readJsonBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }

        if (!isSyncBody(parsed)) {
          json(res, 422, { error: "invalid_body", hint: "deviceId and transactions[] required" });
          return;
        }

        const txns: PaymentTransaction[] = [];
        for (const item of parsed.transactions) {
          if (!isPaymentTransaction(item)) {
            json(res, 422, { error: "invalid_transaction_in_batch" });
            return;
          }
          txns.push(toPaymentTransaction(item));
        }

        const results = await processSyncBatch(engine, txns);
        json(res, 200, { deviceId: parsed.deviceId, results });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: "internal_error", message });
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
  });
}

void bootstrap();
