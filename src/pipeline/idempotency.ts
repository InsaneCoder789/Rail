import type { PipelineResult } from "../domain/types.js";

type RecordState =
  | { status: "inflight"; fingerprint: string; promise: Promise<PipelineResult> }
  | { status: "completed"; fingerprint: string; result: PipelineResult };

export interface IdempotencyStore {
  dedupe(key: string, fingerprint: string, run: () => Promise<PipelineResult>): Promise<PipelineResult>;
  getCompleted(key: string): Promise<PipelineResult | undefined> | PipelineResult | undefined;
}

/**
 * Process-local idempotency (development / single-instance). Use PostgresIdempotencyStore when DATABASE_URL is set.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, RecordState>();

  getCompleted(key: string): PipelineResult | undefined {
    const r = this.records.get(key);
    if (r?.status === "completed") return r.result;
    return undefined;
  }

  /**
   * Ensures a single execution per key; concurrent callers await the same promise.
   * Failed runs are terminal for this key (replay returns the same failure).
   */
  async dedupe(key: string, fingerprint: string, run: () => Promise<PipelineResult>): Promise<PipelineResult> {
    const existing = this.records.get(key);
    if (existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    if (existing?.status === "completed") return existing.result;
    if (existing?.status === "inflight") return existing.promise;

    const promise = (async () => {
      try {
        const result = await run();
        this.records.set(key, { status: "completed", fingerprint, result });
        return result;
      } catch (err) {
        this.records.delete(key);
        throw err;
      }
    })();

    this.records.set(key, { status: "inflight", fingerprint, promise });
    return promise;
  }
}
