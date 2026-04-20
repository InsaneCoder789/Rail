import type { PipelineResult } from "../domain/types.js";

type RecordState =
  | { status: "inflight"; promise: Promise<PipelineResult> }
  | { status: "completed"; result: PipelineResult }
  | { status: "failed"; message: string };

export interface IdempotencyStore {
  dedupe(key: string, run: () => Promise<PipelineResult>): Promise<PipelineResult>;
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
  async dedupe(key: string, run: () => Promise<PipelineResult>): Promise<PipelineResult> {
    const existing = this.records.get(key);
    if (existing?.status === "completed") return existing.result;
    if (existing?.status === "inflight") return existing.promise;
    if (existing?.status === "failed") throw new Error(existing.message);

    const promise = (async () => {
      try {
        const result = await run();
        this.records.set(key, { status: "completed", result });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.records.set(key, { status: "failed", message });
        throw err;
      }
    })();

    this.records.set(key, { status: "inflight", promise });
    return promise;
  }
}
