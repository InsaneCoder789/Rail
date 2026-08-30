import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { Pool } from "pg";
import { ensureOutboxSchema, runMigrations } from "../dist/persistence/migrate.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL migrations create the required runtime tables", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [["wallets", "authorizations", "ledger_entries", "rail_idempotency", "rail_rate_limit_buckets", "outbox"]],
    );
    assert.equal(result.rowCount, 6);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL rate limits are shared and idempotency is durable", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const rateKey = `ci:rate:${suffix}`;
  const idempotencyKey = `ci:idem:${suffix}`;
  try {
    const limiter = new PostgresRateLimiter(pool);
    assert.equal((await limiter.consume(rateKey, 2, 60_000)).remaining, 1);
    assert.equal((await limiter.consume(rateKey, 2, 60_000)).remaining, 0);
    assert.equal((await limiter.consume(rateKey, 2, 60_000)).retryAfterSeconds >= 1, true);

    const store = new PostgresIdempotencyStore(pool);
    const result = await store.dedupe(idempotencyKey, "fingerprint_ci", async () => ({
      status: "accepted",
      ledgerEntryId: "leg_ci",
    }));
    assert.deepEqual(result, { status: "accepted", ledgerEntryId: "leg_ci" });
    assert.deepEqual(await store.dedupe(idempotencyKey, "fingerprint_ci", async () => ({ status: "rejected" })), result);
    await assert.rejects(
      store.dedupe(idempotencyKey, "different_fingerprint", async () => ({ status: "accepted" })),
      { message: "IDEMPOTENCY_KEY_REUSED" },
    );
  } finally {
    await pool.query("DELETE FROM rail_rate_limit_buckets WHERE bucket_key = $1", [rateKey]);
    await pool.query("DELETE FROM rail_idempotency WHERE idempotency_key = $1", [idempotencyKey]);
    await pool.end();
  }
});
