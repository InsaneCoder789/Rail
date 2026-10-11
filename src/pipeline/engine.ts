import type { PaymentTransaction, PipelineResult } from "../domain/types.js";
import { createPaymentContext } from "./context.js";
import type { DeadLetterQueue } from "./dlq.js";
import type { IdempotencyStore } from "./idempotency.js";
import { MemoryOutbox, type OutboxRelay } from "./outbox.js";
import type { Tracer } from "./tracing.js";
import { withSpan } from "./middleware.js";
import type { Stage } from "./stage.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalTransactionPayload, legacyTransactionPayload } from "../crypto/transactionSigning.js";
import { verifyCommittedAuthorization } from "../stages/authorizationStage.js";
import type { TransactionEvidenceStore } from "../persistence/transactionEvidence.js";
import type { PoolClient } from "pg";
import { PipelineError } from "./errors.js";

function randomId(): string {
  return randomUUID();
}

export interface PaymentPipelineEngineOptions {
  readonly idempotency: IdempotencyStore;
  readonly tracer: Tracer;
  readonly dlq: DeadLetterQueue;
  readonly pipeline: Stage;
  readonly relay?: OutboxRelay;
  readonly evidence?: TransactionEvidenceStore;
  readonly riskProtectionRequired?: boolean;
}

/**
 * Top-level orchestrator: idempotency, tracing root span, outbox drain hook, DLQ on hard failures.
 */
export class PaymentPipelineEngine {
  constructor(private readonly opts: PaymentPipelineEngineOptions) {}

  get supportsProtectedTransactions(): boolean {
    return Boolean(this.opts.evidence && this.opts.idempotency.dedupeInTransaction);
  }

  async execute(txn: PaymentTransaction): Promise<PipelineResult> {
    return this.executeBoundary(Object.freeze({ ...txn }));
  }

  /** Internal composition: never return this provisional result to HTTP before outer COMMIT. */
  async executeInTransaction(txn: PaymentTransaction, client: PoolClient): Promise<PipelineResult> {
    if (!this.opts.idempotency.dedupeInTransaction) {
      throw new PipelineError("transactional_idempotency_required", "TRANSACTIONAL_IDEMPOTENCY_REQUIRED");
    }
    return this.executeBoundary(Object.freeze({ ...txn }), client);
  }

  private async executeBoundary(txn: PaymentTransaction, transaction?: PoolClient): Promise<PipelineResult> {
    const span = this.opts.tracer.startSpan("payment.execute", {
      txId: txn.txId,
      idempotencyKey: txn.idempotencyKey,
    });
    try {
      const fingerprint = createHash("sha256")
        .update(canonicalTransactionPayload(txn), "utf8")
        .digest("hex");
      const legacy = legacyTransactionPayload(txn);
      const dedupe = transaction
        ? this.opts.idempotency.dedupeInTransaction!.bind(this.opts.idempotency, transaction)
        : this.opts.idempotency.dedupe.bind(this.opts.idempotency);
      const result = await dedupe(txn.idempotencyKey, fingerprint, async (client) => {
        const outbox = new MemoryOutbox();
        const ctx = createPaymentContext(randomId(), randomId(), txn, outbox, client);
        ctx.state.requireEvidence = Boolean(this.opts.evidence);
        ctx.state.requireRiskProtection = this.opts.riskProtectionRequired === true;
        const root = withSpan(this.opts.tracer, "payment_pipeline", this.opts.pipeline);
        await root(ctx);
        if (!ctx.result) {
          throw new Error("invariant_broken:missing_result");
        }
        if (this.opts.evidence && ctx.result.status === "accepted") {
          if (!client) throw new Error("transaction_evidence_requires_database");
          await this.opts.evidence.persist(client, txn);
        }
        for (const event of outbox.drain()) {
          if (client) {
            await client.query("INSERT INTO outbox (type, payload, occurred_at) VALUES ($1, $2::jsonb, $3::timestamptz)",
              [event.type, JSON.stringify(event.payload), event.occurredAt]);
          } else {
            await this.opts.relay?.(event);
          }
        }
        return ctx.result;
      }, { legacyFingerprint: legacy ? createHash("sha256").update(legacy).digest("hex") : undefined,
        validateLegacy: (client) => verifyCommittedAuthorization(client, txn) });
      span.end("ok", { status: result.status });
      return result;
    } catch (err) {
      span.end("error", { error: err instanceof Error ? err.message : String(err) });
      this.opts.dlq.push({
        idempotencyKey: txn.idempotencyKey,
        txId: txn.txId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

}
