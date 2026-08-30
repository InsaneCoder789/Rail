import dotenv from "dotenv";
import http from "node:http";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config();

import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { MemoryIdempotencyStore } from "../pipeline/idempotency.js";
import { MemoryOutbox } from "../pipeline/outbox.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { PostgresOfflineTokenStore } from "../persistence/postgresOfflineTokenStore.js";
import { ensureOutboxSchema, runMigrations } from "../persistence/migrate.js";
import { createPool } from "../persistence/postgresPool.js";
import { OfflineTokenStore } from "../rail/offlineTokenStore.js";
import { buildHardenedPaymentPipeline, initLedger } from "../stages/paymentPipeline.js";
import {
  initAuthorizationWallet,
  releaseExpiredAuthorizations,
} from "../stages/authorizationStage.js";
import { createAuthResolver } from "./authentication.js";
import { loadServerConfig } from "./config.js";
import { createEventStore } from "./events.js";
import { RateLimitError, RequestError, SlidingWindowRateLimiter, applyCors, json, toErrorResponse } from "./http.js";
import { handleAuthRoutes } from "./routes/authRoutes.js";
import { handleEventRoutes } from "./routes/eventRoutes.js";
import { handlePaymentRoutes } from "./routes/paymentRoutes.js";
import type { ServerContext, ServerIdempotencyStore } from "./types.js";

const tracer = consoleTracer("[rail]");

export async function createServerContext(options: {
  initializeDatabase?: boolean;
  startBackgroundJobs?: boolean;
} = {}): Promise<ServerContext> {
  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_URL;
  let pool = null;
  let offlineTokenStore;
  let idempotency: ServerIdempotencyStore;

  if (databaseUrl) {
    pool = createPool(databaseUrl, config.dbPoolMax);
    const initializeDatabase = options.initializeDatabase ?? !config.serverless;
    const startBackgroundJobs = options.startBackgroundJobs ?? !config.serverless;

    if (initializeDatabase) {
      await runMigrations(pool);
      await ensureOutboxSchema(pool);
    }

    initAuthorizationWallet(pool);
    if (startBackgroundJobs) {
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
    }

    initLedger(pool);
    offlineTokenStore = new PostgresOfflineTokenStore(pool);
    idempotency = new PostgresIdempotencyStore(pool);
    console.log(`Rail: PostgreSQL persistence enabled (pool max ${config.dbPoolMax})`);
  } else {
    offlineTokenStore = new OfflineTokenStore();
    idempotency = new MemoryIdempotencyStore();
    console.warn("Rail: DATABASE_URL not set — using in-memory idempotency + offline tokens (dev only)");
  }

  const eventStore = createEventStore(() => pool);

  const engine = new PaymentPipelineEngine({
    idempotency,
    outbox: new MemoryOutbox(),
    tracer,
    dlq: new MemoryDeadLetterQueue(),
    pipeline: buildHardenedPaymentPipeline(tracer, offlineTokenStore),
    relay: (event) => eventStore.insertOutboxEvent(event),
  });

  return {
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
      apiKeyScopes: config.apiKeyScopes,
    }),
    eventStore,
  };

}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: ServerContext,
): Promise<void> {
    try {
      applyCors(req, res, context.config.allowedOrigins);

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (!req.url || !req.method) {
        json(res, 400, { error: "bad_request" });
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${context.config.port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: "rail",
          persistence: context.databaseUrl ? "postgresql" : "memory",
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

      throw new RequestError(404, "not_found", "route not found");
    } catch (err) {
      console.error("request_failed", err);

      if (!(err instanceof RequestError)) {
        context.eventStore.emitSystemError(err);
      }

      const mapped = toErrorResponse(err, context.config.exposeInternalErrors);
      if (err instanceof RateLimitError) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        res.setHeader("X-RateLimit-Limit", String(err.limit));
        res.setHeader("X-RateLimit-Remaining", String(err.remaining));
      }
      json(res, mapped.status, mapped.body);
    }
}

async function bootstrap(): Promise<void> {
  const context = await createServerContext();
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, context);
  });

  server.listen(context.config.port, () => {
    console.log(`Rail listening on http://0.0.0.0:${context.config.port}`);
    if (context.config.apiKey) {
      console.log("API key authentication: enabled (RAIL_API_KEY or KYLR_API_KEY)");
    } else {
      console.warn("API key authentication: not configured; offline token and sync routes will fail closed");
    }
    console.log(`Request body limit: ${context.config.maxRequestBodyBytes} bytes`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void bootstrap();
}
