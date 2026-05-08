import process from "node:process";

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface ServerConfig {
  readonly port: number;
  readonly apiKey: string;
  readonly maxRequestBodyBytes: number;
  readonly maxSyncBatchSize: number;
  readonly exposeInternalErrors: boolean;
  readonly requireJsonContentType: boolean;
  readonly authSweepIntervalMs: number;
  readonly rateLimits: {
    readonly loginMax: number;
    readonly loginWindowMs: number;
    readonly authorizeMax: number;
    readonly authorizeWindowMs: number;
    readonly executeMax: number;
    readonly executeWindowMs: number;
    readonly syncMax: number;
    readonly syncWindowMs: number;
    readonly tokenIssueMax: number;
    readonly tokenIssueWindowMs: number;
  };
}

export function loadServerConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    apiKey: process.env.RAIL_API_KEY ?? process.env.KYLR_API_KEY ?? "",
    maxRequestBodyBytes: resolvePositiveIntEnv("RAIL_MAX_REQUEST_BODY_BYTES", 64 * 1024),
    maxSyncBatchSize: resolvePositiveIntEnv("RAIL_MAX_SYNC_BATCH_SIZE", 100),
    exposeInternalErrors: process.env.RAIL_EXPOSE_INTERNAL_ERRORS === "true",
    requireJsonContentType: process.env.RAIL_REQUIRE_JSON_CONTENT_TYPE !== "false",
    authSweepIntervalMs: resolvePositiveIntEnv("RAIL_AUTH_SWEEP_INTERVAL_MS", 60_000),
    rateLimits: {
      loginMax: resolvePositiveIntEnv("RAIL_RATE_LIMIT_LOGIN_MAX", 5),
      loginWindowMs: resolvePositiveIntEnv("RAIL_RATE_LIMIT_LOGIN_WINDOW_MS", 15 * 60 * 1000),
      authorizeMax: resolvePositiveIntEnv("RAIL_RATE_LIMIT_AUTHORIZE_MAX", 12),
      authorizeWindowMs: resolvePositiveIntEnv("RAIL_RATE_LIMIT_AUTHORIZE_WINDOW_MS", 60 * 1000),
      executeMax: resolvePositiveIntEnv("RAIL_RATE_LIMIT_EXECUTE_MAX", 20),
      executeWindowMs: resolvePositiveIntEnv("RAIL_RATE_LIMIT_EXECUTE_WINDOW_MS", 60 * 1000),
      syncMax: resolvePositiveIntEnv("RAIL_RATE_LIMIT_SYNC_MAX", 6),
      syncWindowMs: resolvePositiveIntEnv("RAIL_RATE_LIMIT_SYNC_WINDOW_MS", 10 * 60 * 1000),
      tokenIssueMax: resolvePositiveIntEnv("RAIL_RATE_LIMIT_TOKEN_ISSUE_MAX", 6),
      tokenIssueWindowMs: resolvePositiveIntEnv("RAIL_RATE_LIMIT_TOKEN_ISSUE_WINDOW_MS", 10 * 60 * 1000),
    },
  };
}
