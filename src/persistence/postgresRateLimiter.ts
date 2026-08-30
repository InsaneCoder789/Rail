import type { Pool } from "pg";
import type { RateLimiter } from "../server/http.js";

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly pool: Pool) {}

  async consume(key: string, limit: number, windowMs: number): Promise<{ limit: number; remaining: number; retryAfterSeconds: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT window_started_at, hit_count
         FROM rail_rate_limit_buckets
         WHERE bucket_key = $1
         FOR UPDATE`,
        [key],
      );
      const now = Date.now();
      const row = result.rows[0] as { window_started_at: string; hit_count: number } | undefined;
      const elapsed = row ? now - Date.parse(row.window_started_at) : windowMs;
      let hitCount = row?.hit_count ?? 0;
      let windowStartedAt = row ? new Date(row.window_started_at).getTime() : now;

      if (elapsed >= windowMs || !Number.isFinite(windowStartedAt)) {
        hitCount = 0;
        windowStartedAt = now;
      }

      if (hitCount >= limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - windowStartedAt)) / 1000));
        await client.query("COMMIT");
        return { limit, remaining: 0, retryAfterSeconds };
      }

      hitCount += 1;
      await client.query(
        `INSERT INTO rail_rate_limit_buckets (bucket_key, window_started_at, hit_count)
         VALUES ($1, to_timestamp($2 / 1000.0), $3)
         ON CONFLICT (bucket_key) DO UPDATE SET
           window_started_at = EXCLUDED.window_started_at,
           hit_count = EXCLUDED.hit_count`,
        [key, windowStartedAt, hitCount],
      );
      await client.query("COMMIT");
      return { limit, remaining: Math.max(0, limit - hitCount), retryAfterSeconds: 0 };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }
}
