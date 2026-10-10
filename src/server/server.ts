import dotenv from "dotenv";
import http from "node:http";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { validateRiskModel } from "../risk/logisticRisk.js";
dotenv.config();

import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { PostgresOfflineTokenStore } from "../persistence/postgresOfflineTokenStore.js";
import { PostgresRateLimiter } from "../persistence/postgresRateLimiter.js";
import { ensureOutboxSchema, runMigrations } from "../persistence/migrate.js";
import { createPool } from "../persistence/postgresPool.js";
import { buildHardenedPaymentPipeline } from "../stages/paymentPipeline.js";
import { releaseExpiredAuthorizations } from "../stages/authorizationStage.js";
import { createAuthResolver } from "./authentication.js";
import { loadServerConfig } from "./config.js";
import { createEventStore } from "./events.js";
import { RateLimitError, RequestError, applyCors, json, toErrorResponse } from "./http.js";
import { handleAuthRoutes } from "./routes/authRoutes.js";
import { handleEventRoutes } from "./routes/eventRoutes.js";
import { handlePaymentRoutes } from "./routes/paymentRoutes.js";
import type { ServerContext } from "./types.js";

const tracer = consoleTracer("[rail]");

export async function createServerContext(options: {
  initializeDatabase?: boolean;
  startBackgroundJobs?: boolean;
} = {}): Promise<ServerContext> {
  const config = loadServerConfig();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL_REQUIRED_FOR_SERVER");
  const riskModel = process.env.RAIL_RISK_MODEL_PATH
    ? validateRiskModel(JSON.parse(await readFile(process.env.RAIL_RISK_MODEL_PATH, "utf8")))
    : undefined;
  const pool = createPool(databaseUrl, config.dbPoolMax);
  const initializeDatabase = options.initializeDatabase ?? !config.serverless;
  const startBackgroundJobs = options.startBackgroundJobs ?? !config.serverless;

  if (initializeDatabase) {
    try {
      await runMigrations(pool);
      await ensureOutboxSchema(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  if (startBackgroundJobs) {
    const sweepPool = pool;
    const releasedCount = await releaseExpiredAuthorizations(pool).catch((err) => {
      console.error("authorization_sweep_failed", err);
      return 0;
    });
    if (releasedCount > 0) {
      console.log(`Rail: released ${releasedCount} expired authorization reservations`);
    }
    setInterval(() => {
      void releaseExpiredAuthorizations(sweepPool).catch((err) => {
        console.error("authorization_sweep_failed", err);
      });
    }, config.authSweepIntervalMs).unref();
  }

  const offlineTokenStore = new PostgresOfflineTokenStore(pool);
  const idempotency = new PostgresIdempotencyStore(pool);
  console.log(`Rail: PostgreSQL persistence enabled (pool max ${config.dbPoolMax})`);

  const eventStore = createEventStore(() => pool);

  const engine = new PaymentPipelineEngine({
    idempotency,
    tracer,
    dlq: new MemoryDeadLetterQueue(),
    pipeline: buildHardenedPaymentPipeline(tracer, offlineTokenStore, riskModel),
    relay: (event) => eventStore.insertOutboxEvent(event),
  });

  return {
    config,
    pool,
    databaseUrl,
    offlineTokenStore,
    idempotency,
    engine,
    rateLimiter: new PostgresRateLimiter(pool),
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
      if (mapped.status === 413 || mapped.status === 408) {
        // Flush the error response before closing an unread or stalled request body.
        res.setHeader("Connection", "close");
        res.once("finish", () => { req.destroy(); });
      }
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
