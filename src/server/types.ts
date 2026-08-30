import type http from "node:http";
import type { Pool } from "pg";
import type { PaymentPipelineEngine } from "../pipeline/engine.js";
import type { MemoryIdempotencyStore } from "../pipeline/idempotency.js";
import type { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import type { IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import type { ServerConfig } from "./config.js";
import type { SlidingWindowRateLimiter } from "./http.js";

export interface AuthenticatedViewer {
  readonly walletId: string;
}

export interface SseClient {
  readonly res: http.ServerResponse;
  readonly viewer: AuthenticatedViewer;
}

export interface ServerEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt?: string;
}

export type ServerIdempotencyStore = MemoryIdempotencyStore | PostgresIdempotencyStore;

export interface AuthResolver {
  resolveAuthenticatedWallet(
    req: http.IncomingMessage,
    url?: URL,
    options?: { allowQueryCredentials?: boolean },
  ): Promise<string>;
  requireApiKey(req: http.IncomingMessage, res: http.ServerResponse, scope?: string): boolean;
}

export interface EventStore {
  broadcastEvent(event: ServerEvent): void;
  emitSystemError(err: unknown, stage?: string, txId?: string): void;
  insertOutboxEvent(event: ServerEvent): Promise<void>;
  listVisibleEvents(viewer: AuthenticatedViewer, limit?: number): Promise<ServerEvent[]>;
  addSseClient(client: SseClient): void;
  removeSseClient(client: SseClient): void;
}

export interface ServerContext {
  readonly config: ServerConfig;
  readonly pool: Pool | null;
  readonly databaseUrl?: string;
  readonly offlineTokenStore: IOfflineTokenStore;
  readonly idempotency: ServerIdempotencyStore;
  readonly engine: PaymentPipelineEngine;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly authResolver: AuthResolver;
  readonly eventStore: EventStore;
}
