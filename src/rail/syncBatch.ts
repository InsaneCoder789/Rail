import type { PaymentTransaction, PipelineResult } from "../domain/types.js";
import type { PaymentPipelineEngine } from "../pipeline/engine.js";

export interface SyncItemResult {
  readonly txId: string;
  readonly result?: PipelineResult;
  readonly error?: string;
}

/**
 * Processes queued offline transactions in order (FIFO). Each item is expected
 * to have already been validated against a stored authorization reference by the
 * HTTP layer and then uses the same idempotency + pipeline rules as execute.
 */
export async function processSyncBatch(
  engine: PaymentPipelineEngine,
  transactions: PaymentTransaction[],
): Promise<SyncItemResult[]> {
  const out: SyncItemResult[] = [];
  for (const txn of transactions) {
    try {
      const result = await engine.execute(txn);
      out.push({ txId: txn.txId, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      out.push({ txId: txn.txId, error });
    }
  }
  return out;
}
