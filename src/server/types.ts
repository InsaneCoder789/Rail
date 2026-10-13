import type http from "node:http";
import type { Pool } from "pg";
import type { PaymentPipelineEngine } from "../pipeline/engine.js";
import type { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import type { IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import type { ServerConfig } from "./config.js";
import type { RateLimiter } from "./http.js";
import type { TransactionEvidenceStore } from "../persistence/transactionEvidence.js";
import type { AgentAuthorityStore } from "../persistence/agentAuthority.js";
import type { RiskProtectionStore } from "../persistence/riskProtection.js";
import type { AuditBatchStore } from "../persistence/auditBatches.js";

export interface AuthenticatedViewer {
  readonly walletId: string;
}
export interface OwnerPrincipal {
  readonly walletId: string;
  readonly method: "owner_jwt" | "trusted_library";
  readonly userId?: string;
  readonly authVersion?: number;
}

export interface SseClient {
  readonly res: http.ServerResponse;
  readonly viewer: AuthenticatedViewer;
}

export interface ServerEvent {
  readonly id?: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt?: string;
}


export interface AuthResolver {
  resolveOwnerPrincipal?(req: http.IncomingMessage): Promise<OwnerPrincipal>;
  resolveOwnerWallet(req: http.IncomingMessage): Promise<string>;
  resolveAuthenticatedWallet(
    req: http.IncomingMessage,
  ): Promise<string>;
  requireApiKey(req: http.IncomingMessage, res: http.ServerResponse, scope?: string): boolean;
}

export interface EventStore {
  emitSystemError(err: unknown, stage?: string, txId?: string): void;
  insertOutboxEvent(event: ServerEvent): Promise<void>;
  listVisibleEvents(viewer: AuthenticatedViewer, limit?: number, before?: string): Promise<ServerEvent[]>;
  addSseClient(client: SseClient): boolean;
  removeSseClient(client: SseClient): void;
}

export interface ServerContext {
  readonly config: ServerConfig;
  readonly pool: Pool;
  readonly databaseUrl: string;
  readonly offlineTokenStore: IOfflineTokenStore;
  readonly idempotency: PostgresIdempotencyStore;
  readonly engine: PaymentPipelineEngine;
  readonly evidenceStore: TransactionEvidenceStore;
  readonly riskProtection: RiskProtectionStore;
  readonly auditStore: AuditBatchStore;
  readonly agentStore: AgentAuthorityStore;
  readonly rateLimiter: RateLimiter;
  readonly authResolver: AuthResolver;
  readonly eventStore: EventStore;
}
