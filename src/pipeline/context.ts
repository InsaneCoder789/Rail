import type { PaymentTransaction, PipelineResult, RiskAssessment } from "../domain/types.js";
import type { OutboxWriter } from "./outbox.js";
import type { PoolClient } from "pg";

export interface Span {
  end(status: "ok" | "error", attrs?: Record<string, string | number | boolean>): void;
}

export interface PaymentContext {
  readonly traceId: string;
  readonly correlationId: string;
  readonly txn: PaymentTransaction;
  readonly outbox: OutboxWriter;
  readonly dbClient?: PoolClient;
  /** Cross-stage scratch space; prefer typed keys from a shared registry in larger codebases. */
  readonly state: Record<string, unknown>;
  risk?: RiskAssessment;
  result?: PipelineResult;
}

export function createPaymentContext(
  traceId: string,
  correlationId: string,
  txn: PaymentTransaction,
  outbox: OutboxWriter,
  dbClient?: PoolClient,
): PaymentContext {
  return {
    traceId,
    correlationId,
    txn,
    outbox,
    dbClient,
    state: {},
  };
}
