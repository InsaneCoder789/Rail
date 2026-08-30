import type { PipelineResult } from "../domain/types.js";
import type { IdempotencyStore } from "../pipeline/idempotency.js";
import type { Pool } from "pg";

/**
 * Distributed idempotency using PostgreSQL + session advisory locks.
 * Holds one connection for the duration of dedupe (including pipeline run) to serialize same-key replays.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async getCompleted(key: string): Promise<PipelineResult | undefined> {
    const r = await this.pool.query(
      "SELECT status, result_json FROM rail_idempotency WHERE idempotency_key = $1",
      [key],
    );
    if (r.rowCount === 0) {
      return undefined;
    }

    const row = r.rows[0] as { status: string; result_json: unknown };
    if (row.status !== "completed") {
      return undefined;
    }

    return row.result_json as PipelineResult;
  }

  async dedupe(key: string, fingerprint: string, run: () => Promise<PipelineResult>): Promise<PipelineResult> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1::text))", [key]);
      const r = await client.query(
        "SELECT status, result_json, request_fingerprint FROM rail_idempotency WHERE idempotency_key = $1",
        [key],
      );
      if (r.rows.length > 0) {
        const row = r.rows[0] as { status: string; result_json: unknown; request_fingerprint: string | null };
        if (row.request_fingerprint && row.request_fingerprint !== fingerprint) {
          throw new Error("IDEMPOTENCY_KEY_REUSED");
        }
        if (row.status === "completed") {
          return row.result_json as PipelineResult;
        }
      }

      try {
        const result = await run();
        await client.query(
          `INSERT INTO rail_idempotency (idempotency_key, status, result_json, request_fingerprint)
           VALUES ($1, 'completed', $2::jsonb, $3)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'completed',
             result_json = EXCLUDED.result_json,
             request_fingerprint = EXCLUDED.request_fingerprint`,
          [key, JSON.stringify(result), fingerprint],
        );
        return result;
      } catch (err) {
        throw err;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1::text))", [key]);
      client.release();
    }
  }
}
