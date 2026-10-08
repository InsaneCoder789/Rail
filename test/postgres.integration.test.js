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
import { createAuthorization, claimAuthorizationForExecution, getAuthorizationById, releaseExpiredAuthorizations, reserveFunds, creditWallet, releaseReservation } from "../dist/stages/authorizationStage.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { PostgresOfflineTokenStore } from "../dist/persistence/postgresOfflineTokenStore.js";
import { handlePaymentRoutes } from "../dist/server/routes/paymentRoutes.js";
import { createHash } from "node:crypto";
import { legacyTransactionPayload, canonicalTransactionPayload } from "../dist/crypto/transactionSigning.js";
import { dispatchOutboxBatch } from "../dist/persistence/outboxWorker.js";

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
      [["wallets", "authorizations", "ledger_entries", "rail_idempotency", "rail_rate_limit_buckets", "rail_payment_executions", "rail_offline_tokens", "rail_offline_spends", "outbox"]],
    );
    assert.equal(result.rowCount, 9);
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
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ($1, 10000), ($2, 0)", [sender, receiver]);
    const authorizations = await Promise.all(Array.from({ length: 8 }, () => createAuthorization(input, pool)));
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

async function paymentFixture(work) {
  // A single connection proves that execution never nests another checkout.
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
  const suffix = crypto.randomUUID();
  const sender = `ci_sender_${suffix}`;
  const receiver = `ci_receiver_${suffix}`;
  const txId = `ci_payment_${suffix}`;
  const previousSecret = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = previousSecret || "integration_test_signing_secret_0123456789";
  try {
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ($1, 10000), ($2, 0)", [sender, receiver]);
    const auth = await createAuthorization({ txId, senderWalletId: sender, receiverWalletId: receiver, amountMinor: 2500, currency: "INR" }, pool);
    const tokens = new PostgresOfflineTokenStore(pool);
    const token = await tokens.issue({ walletId: sender, deviceId: "ci_device", amountCapMinor: 5000 });
    const txn = { txId, idempotencyKey: `ci_idem_${suffix}`, authorizationId: auth.authId, senderWalletId: sender,
      receiverWalletId: receiver, amountMinor: 2500, currency: "INR", channel: "nfc",
      deviceId: "ci_device", offlineTokenId: token.tokenId, createdAt: new Date().toISOString() };
    const store = new PostgresIdempotencyStore(pool);
    const makeEngine = (idempotency = store, pipeline = buildHardenedPaymentPipeline(noopTracer, tokens)) => new PaymentPipelineEngine({
      idempotency, tracer: noopTracer, dlq: new MemoryDeadLetterQueue(), pipeline,
    });
    await work({ pool, txn, auth, tokens, token, store, makeEngine });
  } finally {
    await pool.query("DELETE FROM outbox WHERE payload->>'txId' = $1", [txId]);
    await pool.query("DELETE FROM rail_idempotency WHERE idempotency_key LIKE $1", [`ci_idem_${suffix}%`]);
    await pool.query("DELETE FROM rail_payment_executions WHERE tx_id = $1", [txId]);
    await pool.query("DELETE FROM ledger_entries WHERE tx_id = $1", [txId]);
    await pool.query("DELETE FROM authorization_usage WHERE tx_id = $1", [txId]);
    await pool.query("DELETE FROM authorizations WHERE tx_id = $1", [txId]);
    await pool.query("DELETE FROM rail_offline_spends WHERE token_id IN (SELECT token_id FROM rail_offline_tokens WHERE wallet_id = $1)", [sender]);
    await pool.query("DELETE FROM rail_offline_tokens WHERE wallet_id = $1", [sender]);
    await pool.query("DELETE FROM wallets WHERE wallet_id = ANY($1::text[])", [[sender, receiver]]);
    await pool.end();
    if (previousSecret === undefined) delete process.env.RAIL_SIGNING_SECRET;
    else process.env.RAIL_SIGNING_SECRET = previousSecret;
  }
}

test("PostgreSQL offline reservations reject invalid amounts and cannot double-reserve or double-refund", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ txn, tokens, token }) => {
    await assert.rejects(tokens.issue({ walletId: txn.senderWalletId, deviceId: "ci_device", amountCapMinor: NaN }), /invalid_amount_cap/);
    await assert.rejects(tokens.issue({ walletId: txn.senderWalletId, deviceId: "ci_device", amountCapMinor: 5000, ttlSeconds: Infinity }), /invalid_token_ttl/);
    assert.deepEqual(await tokens.beginOfflineSpend({ ...txn, txId: undefined }), { ok: false, reason: "invalid_transaction" });
    for (const amountMinor of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(await tokens.beginOfflineSpend({ ...txn, amountMinor }), { ok: false, reason: "invalid_amount" });
    }
    await tokens.rollbackOfflineSpend(txn);
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 5000);
    const reservations = await Promise.all(Array.from({ length: 8 }, () => tokens.beginOfflineSpend(txn)));
    assert.ok(reservations.every(result => result.ok));
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 2500);
    await assert.rejects(tokens.rollbackOfflineSpend({ ...txn, amountMinor: 1 }), /offline_spend_mismatch/);
    await tokens.rollbackOfflineSpend(txn);
    await tokens.rollbackOfflineSpend(txn);
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 5000);
    await tokens.beginOfflineSpend(txn);
    await tokens.finalizeOfflineSpend(txn);
    await tokens.rollbackOfflineSpend(txn);
    await tokens.beginOfflineSpend(txn);
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 2500);
  });
});

test("payment, token usage, ledger, events and replay result commit atomically with a one-connection pool", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, tokens, token, makeEngine }) => {
    const engine = makeEngine();
    const results = await Promise.all(Array.from({ length: 6 }, () => engine.execute(txn)));
    assert.ok(results.every((result) => result.status === "accepted"));
    assert.equal((await pool.query("SELECT * FROM ledger_entries WHERE tx_id = $1", [txn.txId])).rowCount, 2);
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 2500);
    const events = await pool.query("SELECT * FROM outbox WHERE payload->>'txId' = $1", [txn.txId]);
    assert.ok(events.rowCount > 0);
    const initialEventCount = events.rowCount;
    await engine.execute(txn);
    assert.equal((await pool.query("SELECT * FROM outbox WHERE payload->>'txId' = $1", [txn.txId])).rowCount, initialEventCount);
    const wallets = await pool.query("SELECT wallet_id, balance, reserved FROM wallets WHERE wallet_id = ANY($1::text[])", [[txn.senderWalletId, txn.receiverWalletId]]);
    assert.equal(Number(wallets.rows.find((row) => row.wallet_id === txn.senderWalletId).balance), 7500);
    assert.equal(Number(wallets.rows.find((row) => row.wallet_id === txn.senderWalletId).reserved), 0);
    assert.equal(Number(wallets.rows.find((row) => row.wallet_id === txn.receiverWalletId).balance), 2500);
    assert.equal((await pool.query("SELECT * FROM rail_payment_executions WHERE tx_id = $1", [txn.txId])).rowCount, 1);
  });
});

test("failure after wallet execution but before replay-result storage rolls back all effects and permits retry", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, tokens, token, store, makeEngine }) => {
    const failingStore = {
      dedupe(key, fingerprint, run, options) {
        return store.dedupe(key, fingerprint, async (client) => {
          await run(client);
          throw new Error("simulated_failure_before_result");
        }, options);
      },
    };
    await assert.rejects(makeEngine(failingStore).execute(txn), { message: "simulated_failure_before_result" });
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 5000);
    assert.equal((await pool.query("SELECT * FROM ledger_entries WHERE tx_id = $1", [txn.txId])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_payment_executions WHERE tx_id = $1", [txn.txId])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_idempotency WHERE idempotency_key = $1", [txn.idempotencyKey])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM outbox WHERE payload->>'txId' = $1", [txn.txId])).rowCount, 0);
    assert.equal((await pool.query("SELECT status FROM authorizations WHERE auth_id = $1", [txn.authorizationId])).rows[0].status, "issued");
    assert.equal((await makeEngine().execute(txn)).status, "accepted");
  });
});

test("lost-response replay reaches the engine through HTTP after authorization expiry", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, store, makeEngine }) => {
    const engine = makeEngine();
    const original = await engine.execute(txn);
    await pool.query("UPDATE authorizations SET expires_at = NOW() - INTERVAL '1 hour' WHERE auth_id = $1", [txn.authorizationId]);
    const request = Readable.from([JSON.stringify(txn)]);
    request.method = "POST";
    request.headers = { "content-type": "application/json" };
    request.socket = { remoteAddress: "127.0.0.1" };
    let status;
    let body;
    const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
    const context = { pool, config: loadServerConfig(), engine, idempotency: store, rateLimiter: new SlidingWindowRateLimiter(),
      authResolver: { async resolveAuthenticatedWallet() { return txn.senderWalletId; } } };
    await handlePaymentRoutes(request, response, new URL("http://localhost/v1/payments/execute"), context);
    assert.equal(status, 200);
    assert.deepEqual(body.result, original);
    await assert.rejects(engine.execute({ ...txn, idempotencyKey: `${txn.idempotencyKey}_changed` }), { message: "PAYMENT_ALREADY_EXECUTED" });
    await assert.rejects(engine.execute({ ...txn, authorizationId: "altered_authorization" }), { message: "IDEMPOTENCY_KEY_REUSED" });
  });
});

test("verified legacy replay fingerprints migrate without rerunning financial effects", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    const engine = makeEngine();
    const result = await engine.execute(txn);
    await pool.query("UPDATE rail_idempotency SET request_fingerprint = $2 WHERE idempotency_key = $1",
      [txn.idempotencyKey, createHash("sha256").update(legacyTransactionPayload(txn)).digest("hex")]);
    assert.deepEqual(await engine.execute(txn), result);
    const saved = await pool.query("SELECT request_fingerprint FROM rail_idempotency WHERE idempotency_key = $1", [txn.idempotencyKey]);
    assert.equal(saved.rows[0].request_fingerprint, createHash("sha256").update(canonicalTransactionPayload(txn)).digest("hex"));
  });
});

test("terminating the transaction connection before commit leaves no partial payment and retry succeeds", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, store, tokens, token, makeEngine }) => {
    const terminating = { dedupe(key, fingerprint, run, options) {
      return store.dedupe(key, fingerprint, async (client) => {
        await run(client);
        await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
        return { status: "accepted" };
      }, options);
    } };
    await assert.rejects(makeEngine(terminating).execute(txn));
    assert.equal((await pool.query("SELECT * FROM ledger_entries WHERE tx_id = $1", [txn.txId])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM outbox WHERE payload->>'txId' = $1", [txn.txId])).rowCount, 0);
    assert.equal((await tokens.getToken(token.tokenId)).remainingMinor, 5000);
    assert.equal((await makeEngine().execute(txn)).status, "accepted");
  });
});

test("outbox leases exclude parallel workers and failed deliveries retry with a stable ID", { skip: !databaseUrl }, async () => {
  const schema = `ci_outbox_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await ensureOutboxSchema(pool);
    const row = (await pool.query("INSERT INTO outbox (type, payload) VALUES ('test.event', '{}') RETURNING id")).rows[0];
    const ids = [];
    const policies = { batchSize: 1, leaseMs: 1000, deliveryTimeoutMs: 500, retryDelayMs: 60_000, maxAttempts: 2 };
    const workers = await Promise.all([1, 2].map(() => dispatchOutboxBatch(pool, async (event) => {
      ids.push(event.deliveryId);
      throw new Error("external_failure");
    }, policies)));
    assert.equal(workers.reduce((sum, worker) => sum + worker.failed, 0), 1);
    await pool.query("UPDATE outbox SET next_attempt_at = NOW() - INTERVAL '1 second'");
    const retried = await dispatchOutboxBatch(pool, async (event) => { ids.push(event.deliveryId); }, policies);
    assert.equal(retried.delivered, 1);
    assert.deepEqual(ids, [String(row.id), String(row.id)]);
    assert.equal((await pool.query("SELECT delivery_status, delivery_attempts FROM outbox")).rows[0].delivery_attempts, 2);
    assert.equal((await dispatchOutboxBatch(pool, async () => assert.fail("delivered event replayed"), policies)).delivered, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

async function authorizationExpiryFixture(work) {
  const schema = `ci_authorization_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  const previousSecret = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = previousSecret || "integration_test_signing_secret_0123456789";
  try {
    await runMigrations(pool);
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ('expiry_sender', 10000), ('expiry_receiver', 0)");
    const input = { txId: "expiry_transaction_one", senderWalletId: "expiry_sender", receiverWalletId: "expiry_receiver", amountMinor: 2500, currency: "INR" };
    const auth = await createAuthorization(input, pool);
    await pool.query("UPDATE authorizations SET expires_at = NOW() - INTERVAL '1 second' WHERE auth_id = $1", [auth.authId]);
    await work({ pool, input, auth });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousSecret === undefined) delete process.env.RAIL_SIGNING_SECRET;
    else process.env.RAIL_SIGNING_SECRET = previousSecret;
  }
}

test("concurrent authorization reads and sweeps release expired reservations exactly once", { skip: !databaseUrl }, async () => {
  await authorizationExpiryFixture(async ({ pool, auth }) => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2 ? getAuthorizationById(auth.authId, pool) : releaseExpiredAuthorizations(pool)));
    const stored = await getAuthorizationById(auth.authId, pool);
    assert.equal(stored.status, "expired");
    assert.ok(stored.releasedAt);
    const wallet = (await pool.query("SELECT balance, reserved FROM wallets WHERE wallet_id = 'expiry_sender'")).rows[0];
    assert.equal(Number(wallet.balance), 10000);
    assert.equal(Number(wallet.reserved), 0);
    assert.equal(await releaseExpiredAuthorizations(pool), 0);
    await assert.rejects(releaseExpiredAuthorizations(pool, -1), /invalid_sweep_limit/);
  });
});

test("authorization issuance recovers expired headroom without a background timer", { skip: !databaseUrl }, async () => {
  await authorizationExpiryFixture(async ({ pool, input, auth }) => {
    const next = await createAuthorization({ ...input, txId: "expiry_transaction_two", amountMinor: 9000 }, pool);
    assert.notEqual(next.authId, auth.authId);
    assert.equal((await getAuthorizationById(auth.authId, pool)).status, "expired");
    const wallet = (await pool.query("SELECT balance, reserved FROM wallets WHERE wallet_id = 'expiry_sender'")).rows[0];
    assert.equal(Number(wallet.balance), 1000);
    assert.equal(Number(wallet.reserved), 9000);
    const replay = await createAuthorization(input, pool);
    assert.equal(replay.authId, auth.authId);
    assert.equal(replay.status, "expired");
    await assert.rejects(createAuthorization({ ...input, amountMinor: 1 }, pool), /AUTHORIZATION_TX_CONFLICT/);
  });
});

test("wallet reservation helpers reject invalid money and cannot over-release funds", { skip: !databaseUrl }, async () => {
  await authorizationExpiryFixture(async ({ pool, input }) => {
    const client = await pool.connect();
    try {
      for (const operation of [reserveFunds, creditWallet, releaseReservation]) {
        for (const amount of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
          await assert.rejects(operation(client, input.senderWalletId, amount, "INR"), /INVALID_TRANSACTION/);
        }
      }
      await assert.rejects(releaseReservation(client, input.senderWalletId, 2501, "INR"), /RESERVATION_WALLET_NOT_FOUND/);
      await assert.rejects(createAuthorization({ ...input, ttlMs: Infinity }, pool), /INVALID_TRANSACTION/);
      const wallet = (await client.query("SELECT balance, reserved FROM wallets WHERE wallet_id = $1", [input.senderWalletId])).rows[0];
      assert.equal(Number(wallet.balance), 7500);
      assert.equal(Number(wallet.reserved), 2500);
    } finally {
      client.release();
    }
  });
});

test("failed expiry release rolls back instead of marking inconsistent reservations expired", { skip: !databaseUrl }, async () => {
  await authorizationExpiryFixture(async ({ pool, auth }) => {
    await pool.query("UPDATE wallets SET balance = 10000, reserved = 0 WHERE wallet_id = 'expiry_sender'");
    await assert.rejects(getAuthorizationById(auth.authId, pool), /RESERVATION_WALLET_NOT_FOUND/);
    const stored = (await pool.query("SELECT status, released_at FROM authorizations WHERE auth_id = $1", [auth.authId])).rows[0];
    assert.equal(stored.status, "issued");
    assert.equal(stored.released_at, null);
    const wallet = (await pool.query("SELECT balance, reserved FROM wallets WHERE wallet_id = 'expiry_sender'")).rows[0];
    assert.equal(Number(wallet.balance), 10000);
    assert.equal(Number(wallet.reserved), 0);
  });
});

test("execution checks the current database clock rather than a stale transaction-start timestamp", { skip: !databaseUrl }, async () => {
  await authorizationExpiryFixture(async ({ pool, auth, input }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE authorizations SET expires_at = transaction_timestamp() + INTERVAL '1 millisecond' WHERE auth_id = $1", [auth.authId]);
      await client.query("SELECT pg_sleep(0.02)");
      await assert.rejects(claimAuthorizationForExecution(client, auth.authId, input), /AUTH_NOT_EXECUTABLE/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

test("outbox retries end in dead letters and expired worker leases can be reclaimed", { skip: !databaseUrl }, async () => {
  const schema = `ci_outbox_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  try {
    await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO outbox (type, payload) VALUES ('test.dead_letter', '{}')");
    const policy = { batchSize: 1, maxAttempts: 1, leaseMs: 1000, deliveryTimeoutMs: 500 };
    await dispatchOutboxBatch(pool, async () => { throw new Error("failure"); }, policy);
    assert.equal((await pool.query("SELECT delivery_status FROM outbox")).rows[0].delivery_status, "dead_letter");
    await pool.query(`INSERT INTO outbox (type, payload, delivery_status, delivery_attempts, lease_id, lease_expires_at)
      VALUES ('test.recovered', '{}', 'processing', 1, $1::uuid, NOW() - INTERVAL '1 second')`, [crypto.randomUUID()]);
    const result = await dispatchOutboxBatch(pool, async () => {}, { ...policy, maxAttempts: 3 });
    assert.equal(result.delivered, 1);
    const row = (await pool.query("SELECT * FROM outbox WHERE type = 'test.recovered'")).rows[0];
    assert.equal(row.delivery_attempts, 2);
    assert.equal(row.delivery_status, "delivered");
    assert.equal(row.lease_id, null);
    await pool.query("INSERT INTO outbox (type, payload) VALUES ('test.timeout', '{}')");
    const timed = await dispatchOutboxBatch(pool, async () => new Promise(() => {}),
      { ...policy, leaseMs: 100, deliveryTimeoutMs: 10 });
    assert.equal(timed.failed, 1);
    assert.equal((await pool.query("SELECT delivery_status FROM outbox WHERE type = 'test.timeout'")).rows[0].delivery_status, "dead_letter");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
