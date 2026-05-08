import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { MemoryIdempotencyStore } from "../pipeline/idempotency.js";
import { MemoryOutbox } from "../pipeline/outbox.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { PostgresOfflineTokenStore } from "../persistence/postgresOfflineTokenStore.js";
import { runMigrations } from "../persistence/migrate.js";
import { createPool } from "../persistence/postgresPool.js";
import { OfflineTokenStore } from "../rail/offlineTokenStore.js";
import { buildHardenedPaymentPipeline, initLedger } from "../stages/paymentPipeline.js";
import {
  initAuthorizationWallet,
  releaseExpiredAuthorizations,
} from "../stages/authorizationStage.js";
import { createAuthResolver } from "./authentication.js";
import { loadServerConfig } from "./config.js";
import { attachEngineOutboxForwarding, createEventStore, installConsoleRelay } from "./events.js";
import { RateLimitError, RequestError, SlidingWindowRateLimiter, json, toErrorResponse } from "./http.js";
import { handleAuthRoutes } from "./routes/authRoutes.js";
import { handleEventRoutes } from "./routes/eventRoutes.js";
import { handlePaymentRoutes } from "./routes/paymentRoutes.js";
import type { ServerContext, ServerIdempotencyStore } from "./types.js";

const tracer = consoleTracer("[rail]");

async function bootstrap(): Promise<void> {
  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_URL;
  let pool = null;
  let offlineTokenStore;
  let idempotency: ServerIdempotencyStore;

  if (databaseUrl) {
    pool = createPool(databaseUrl);
    await runMigrations(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id BIGSERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_occurred_at_desc
      ON outbox (occurred_at DESC);
    `);

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
    }, config.authSweepIntervalMs).unref();

    initLedger(pool);
    offlineTokenStore = new PostgresOfflineTokenStore(pool);
    idempotency = new PostgresIdempotencyStore(pool);
    console.log("Rail: PostgreSQL persistence enabled (DATABASE_URL)");
  } else {
    offlineTokenStore = new OfflineTokenStore();
    idempotency = new MemoryIdempotencyStore();
    console.warn("Rail: DATABASE_URL not set — using in-memory idempotency + offline tokens (dev only)");
  }

  const engine = new PaymentPipelineEngine({
    idempotency,
    outbox: new MemoryOutbox(),
    tracer,
    dlq: new MemoryDeadLetterQueue(),
    pipeline: buildHardenedPaymentPipeline(tracer, offlineTokenStore),
  });

  const eventStore = createEventStore(() => pool);
  installConsoleRelay(eventStore);
  attachEngineOutboxForwarding(engine, eventStore);

  const context: ServerContext = {
    config,
    pool,
    databaseUrl,
    offlineTokenStore,
    idempotency,
    engine,
    rateLimiter: new SlidingWindowRateLimiter(),
    authResolver: createAuthResolver({
      getPool: () => pool,
      apiKey: config.apiKey,
    }),
    eventStore,
  };

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-RAIL-API-KEY, X-KYLR-API-KEY");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (!req.url || !req.method) {
        json(res, 400, { error: "bad_request" });
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${config.port}`);

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

      if (await handleAuthRoutes(req, res, url, context)) {
        return;
      }
      if (await handlePaymentRoutes(req, res, url, context)) {
        return;
      }
      if (await handleEventRoutes(req, res, url, context)) {
        return;
      }

      json(res, 200, { status: "success" });
    } catch (err) {
      console.error("request_failed", err);

      context.eventStore.emitSystemError(err);
      if (err instanceof RequestError) {
        context.eventStore.emitSystemError({
          name: err.code,
          message: err.message,
        });
      }

      const mapped = toErrorResponse(err, config.exposeInternalErrors);
      if (err instanceof RateLimitError) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        res.setHeader("X-RateLimit-Limit", String(err.limit));
        res.setHeader("X-RateLimit-Remaining", String(err.remaining));
      }
      json(res, mapped.status, mapped.body);
    }
  });

  server.listen(config.port, () => {
    console.log(`Rail listening on http://0.0.0.0:${config.port}`);
    if (config.apiKey) {
      console.log("API key authentication: enabled (RAIL_API_KEY or KYLR_API_KEY)");
    } else {
      console.warn("API key authentication: not configured; offline token and sync routes will fail closed");
    }
    console.log(`Request body limit: ${config.maxRequestBodyBytes} bytes`);
  });
}

void bootstrap();
