import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { Pool } from "pg";
import { ensureOutboxSchema, runMigrations } from "../dist/persistence/migrate.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";
import { Readable } from "node:stream";
import { handleAuthRoutes } from "../dist/server/routes/authRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";
import { SlidingWindowRateLimiter } from "../dist/server/http.js";
import { initAuthorizationWallet, createAuthorization, claimAuthorizationForExecution } from "../dist/stages/authorizationStage.js";

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

test("concurrent first requests cannot exceed a new PostgreSQL rate-limit bucket", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const key = `ci:concurrent:${crypto.randomUUID()}`;
  try {
    const decisions = await Promise.all(Array.from({ length: 12 }, () =>
      new PostgresRateLimiter(pool).consume(key, 3, 60_000)));
    assert.equal(decisions.filter((decision) => decision.retryAfterSeconds === 0).length, 3);
    assert.equal(decisions.filter((decision) => decision.retryAfterSeconds > 0).length, 9);
    assert.equal(Number((await pool.query("SELECT hit_count FROM rail_rate_limit_buckets WHERE bucket_key = $1", [key])).rows[0].hit_count), 3);
  } finally {
    await pool.query("DELETE FROM rail_rate_limit_buckets WHERE bucket_key = $1", [key]);
    await pool.end();
  }
});

test("registration cannot claim a pre-existing wallet", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const walletId = `ci_wallet_${crypto.randomUUID()}`;
  try {
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ($1, 9000)", [walletId]);
    const request = Readable.from([JSON.stringify({ userId: walletId, password: "test_password_123" })]);
    request.method = "POST";
    request.headers = { "content-type": "application/json" };
    request.socket = { remoteAddress: "127.0.0.1" };
    const response = { setHeader() {} };
    const context = { pool, config: loadServerConfig(), rateLimiter: new SlidingWindowRateLimiter() };
    await assert.rejects(handleAuthRoutes(request, response, new URL("http://localhost/auth/register"), context),
      { status: 409, code: "wallet_exists" });
    assert.equal((await pool.query("SELECT * FROM users WHERE user_id = $1", [walletId])).rowCount, 0);
    assert.equal(Number((await pool.query("SELECT balance FROM wallets WHERE wallet_id = $1", [walletId])).rows[0].balance), 9000);
  } finally {
    await pool.query("DELETE FROM users WHERE user_id = $1", [walletId]);
    await pool.query("DELETE FROM wallets WHERE wallet_id = $1", [walletId]);
    await pool.end();
  }
});

test("concurrent authorization retries reserve once and reject mismatched engine claims", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const suffix = crypto.randomUUID();
  const sender = `ci_sender_${suffix}`;
  const receiver = `ci_receiver_${suffix}`;
  const input = { txId: `ci_tx_${suffix}`, senderWalletId: sender, receiverWalletId: receiver, amountMinor: 2500, currency: "INR" };
  const previousSecret = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = previousSecret || "integration_test_signing_secret_0123456789";
  try {
    initAuthorizationWallet(pool);
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ($1, 10000), ($2, 0)", [sender, receiver]);
    const authorizations = await Promise.all(Array.from({ length: 8 }, () => createAuthorization(input)));
    assert.equal(new Set(authorizations.map((auth) => auth.authId)).size, 1);
    const wallet = (await pool.query("SELECT balance, reserved FROM wallets WHERE wallet_id = $1", [sender])).rows[0];
    assert.equal(Number(wallet.balance), 7500);
    assert.equal(Number(wallet.reserved), 2500);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const change of [{ amountMinor: 1 }, { senderWalletId: receiver }, { receiverWalletId: sender }, { currency: "USD" }]) {
        await assert.rejects(claimAuthorizationForExecution(client, authorizations[0].authId, { ...input, ...change }),
          { message: "AUTH_NOT_EXECUTABLE" });
      }
      await claimAuthorizationForExecution(client, authorizations[0].authId, input);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  } finally {
    await pool.query("DELETE FROM authorizations WHERE tx_id = $1", [input.txId]);
    await pool.query("DELETE FROM wallets WHERE wallet_id = ANY($1::text[])", [[sender, receiver]]);
    await pool.end();
    if (previousSecret === undefined) delete process.env.RAIL_SIGNING_SECRET;
    else process.env.RAIL_SIGNING_SECRET = previousSecret;
  }
});
