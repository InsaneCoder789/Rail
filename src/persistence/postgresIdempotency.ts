import type { PipelineResult } from "../domain/types.js";
import type { DedupeOptions, IdempotencyStore, IdempotencyWork } from "../pipeline/idempotency.js";
import type { Pool } from "pg";
import { PipelineError } from "../pipeline/errors.js";

/**
 * One transaction owns the lock, payment mutations, events and replay response.
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

  async dedupe(key: string, fingerprint: string, run: IdempotencyWork, options?: DedupeOptions): Promise<PipelineResult> {
    const client = await this.pool.connect();
    let discard = false;
    const onClientError = () => { discard = true; };
    client.on("error", onClientError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`idempotency:${key}`]);
      const r = await client.query(
        "SELECT status, result_json, request_fingerprint FROM rail_idempotency WHERE idempotency_key = $1",
        [key],
      );
      if (r.rows.length > 0) {
        const row = r.rows[0] as { status: string; result_json: unknown; request_fingerprint: string | null };
        if (row.request_fingerprint !== fingerprint) {
          if (!row.request_fingerprint || row.request_fingerprint !== options?.legacyFingerprint || !options.validateLegacy) {
            throw new PipelineError("IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_KEY_REUSED");
          }
          await options.validateLegacy(client);
          await client.query("UPDATE rail_idempotency SET request_fingerprint = $2 WHERE idempotency_key = $1", [key, fingerprint]);
        }
        if (row.status === "completed") {
          await client.query("COMMIT");
          return row.result_json as PipelineResult;
        }
      }

      try {
        const result = await run(client);
        await client.query(
          `INSERT INTO rail_idempotency (idempotency_key, status, result_json, request_fingerprint)
           VALUES ($1, 'completed', $2::jsonb, $3)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'completed',
             result_json = EXCLUDED.result_json,
             request_fingerprint = EXCLUDED.request_fingerprint`,
          [key, JSON.stringify(result), fingerprint],
        );
        await client.query("COMMIT");
        return result;
      } catch (err) {
        throw err;
      }
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw err;
    } finally {
      client.release(discard);
      client.removeListener("error", onClientError);
    }
  }
}
