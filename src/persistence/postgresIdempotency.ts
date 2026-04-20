import type { PipelineResult } from "../domain/types.js";
import type { IdempotencyStore } from "../pipeline/idempotency.js";
import type { Pool } from "pg";

/**
 * Distributed idempotency using PostgreSQL + session advisory locks.
 * Holds one connection for the duration of dedupe (including pipeline run) to serialize same-key replays.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async dedupe(key: string, run: () => Promise<PipelineResult>): Promise<PipelineResult> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1::text))", [key]);
      const r = await client.query(
        "SELECT status, result_json, error_message FROM rail_idempotency WHERE idempotency_key = $1",
        [key],
      );
      if (r.rows.length > 0) {
        const row = r.rows[0] as { status: string; result_json: unknown; error_message: string | null };
        if (row.status === "completed") {
          return row.result_json as PipelineResult;
        }
        if (row.status === "failed") {
          throw new Error(row.error_message ?? "previous_failed");
        }
      }

      try {
        const result = await run();
        await client.query(
          `INSERT INTO rail_idempotency (idempotency_key, status, result_json)
           VALUES ($1, 'completed', $2::jsonb)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'completed',
             result_json = EXCLUDED.result_json`,
          [key, JSON.stringify(result)],
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await client.query(
          `INSERT INTO rail_idempotency (idempotency_key, status, error_message)
           VALUES ($1, 'failed', $2)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'failed',
             error_message = EXCLUDED.error_message`,
          [key, message],
        );
        throw err;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1::text))", [key]);
      client.release();
    }
  }
}
