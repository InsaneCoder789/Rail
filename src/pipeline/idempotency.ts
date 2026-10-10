import type { PipelineResult } from "../domain/types.js";
import type { PoolClient } from "pg";
import { PipelineError } from "./errors.js";

export interface DedupeOptions {
  readonly legacyFingerprint?: string;
  readonly validateLegacy?: (client: PoolClient) => Promise<void>;
}
export type IdempotencyWork = (client?: PoolClient) => Promise<PipelineResult>;

type RecordState =
  | { status: "inflight"; fingerprint: string; promise: Promise<PipelineResult> }
  | { status: "completed"; fingerprint: string; result: PipelineResult };

export interface IdempotencyStore {
  dedupe(key: string, fingerprint: string, run: IdempotencyWork, options?: DedupeOptions): Promise<PipelineResult>;
  getCompleted(key: string): Promise<PipelineResult | undefined> | PipelineResult | undefined;
}

/**
 * Process-local idempotency (development / single-instance). Use PostgresIdempotencyStore when DATABASE_URL is set.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, RecordState>();

  constructor(private readonly capacity = 10000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid_idempotency_capacity");
  }

  getCompleted(key: string): PipelineResult | undefined {
    const r = this.records.get(key);
    if (r?.status === "completed") return { ...r.result };
    return undefined;
  }

  /**
   * Ensures a single execution per key; concurrent callers await the same promise.
   * Failed runs are removed so temporary failures can be retried.
   */
  async dedupe(key: string, fingerprint: string, run: () => Promise<PipelineResult>): Promise<PipelineResult> {
    const existing = this.records.get(key);
    if (existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
      throw new PipelineError("IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_KEY_REUSED");
    }
    if (existing?.status === "completed") return { ...existing.result };
    if (existing?.status === "inflight") return { ...await existing.promise };
    // Never evict completed replay state merely to admit new payments.
    if (this.records.size >= this.capacity) throw new PipelineError("MEMORY_IDEMPOTENCY_CAPACITY", "MEMORY_IDEMPOTENCY_CAPACITY");

    // Defer invocation until the inflight record exists, including sync throws.
    const promise = Promise.resolve().then(run).then(result => {
      const stored = Object.freeze({ ...result });
      this.records.set(key, { status: "completed", fingerprint, result: stored });
      return stored;
    }).catch(err => {
      this.records.delete(key);
      throw err;
    });

    this.records.set(key, { status: "inflight", fingerprint, promise });
    return { ...await promise };
  }
}
