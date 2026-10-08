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

function randomId(): string {
  return randomUUID();
}

export interface PaymentPipelineEngineOptions {
  readonly idempotency: IdempotencyStore;
  readonly tracer: Tracer;
  readonly dlq: DeadLetterQueue;
  readonly pipeline: Stage;
  readonly relay?: OutboxRelay;
}

/**
 * Top-level orchestrator: idempotency, tracing root span, outbox drain hook, DLQ on hard failures.
 */
export class PaymentPipelineEngine {
  constructor(private readonly opts: PaymentPipelineEngineOptions) {}

  async execute(txn: PaymentTransaction): Promise<PipelineResult> {
    const span = this.opts.tracer.startSpan("payment.execute", {
      txId: txn.txId,
      idempotencyKey: txn.idempotencyKey,
    });
    try {
      const fingerprint = createHash("sha256")
        .update(canonicalTransactionPayload(txn), "utf8")
        .digest("hex");
      const legacy = legacyTransactionPayload(txn);
      const result = await this.opts.idempotency.dedupe(txn.idempotencyKey, fingerprint, async (client) => {
        const outbox = new MemoryOutbox();
        const ctx = createPaymentContext(randomId(), randomId(), txn, outbox, client);
        const root = withSpan(this.opts.tracer, "payment_pipeline", this.opts.pipeline);
        await root(ctx);
        if (!ctx.result) {
          throw new Error("invariant_broken:missing_result");
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
