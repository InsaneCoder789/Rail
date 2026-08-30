import type { PaymentTransaction, PipelineResult } from "../domain/types.js";
import { createPaymentContext } from "./context.js";
import type { DeadLetterQueue } from "./dlq.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { OutboxRelay, OutboxWriter } from "./outbox.js";
import type { Tracer } from "./tracing.js";
import { withSpan } from "./middleware.js";
import type { Stage } from "./stage.js";
import { createHash } from "node:crypto";
import { canonicalTransactionPayload } from "../crypto/transactionSigning.js";

function randomId(): string {
  return `${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
}

export interface PaymentPipelineEngineOptions {
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
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
      const result = await this.opts.idempotency.dedupe(txn.idempotencyKey, fingerprint, async () => {
        const ctx = createPaymentContext(randomId(), randomId(), txn, this.opts.outbox);
        const root = withSpan(this.opts.tracer, "payment_pipeline", this.opts.pipeline);
        await root(ctx);
        if (!ctx.result) {
          throw new Error("invariant_broken:missing_result");
        }
        this.flushOutboxRelay(this.opts.relay);
        return ctx.result;
      });
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

  /** Simulate Kafka relay / bridge worker that publishes drained outbox events. */
  flushOutboxRelay(relay?: OutboxRelay): void {
    for (const evt of this.opts.outbox.drain()) {
      void relay?.(evt);
    }
  }
}
