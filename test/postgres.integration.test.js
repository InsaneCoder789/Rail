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
import { createAuthorization, claimAuthorizationForExecution, getAuthorizationById, releaseExpiredAuthorizations, reserveFunds, consumeReservation, creditWallet, releaseReservation } from "../dist/stages/authorizationStage.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { PostgresOfflineTokenStore } from "../dist/persistence/postgresOfflineTokenStore.js";
import { handlePaymentRoutes } from "../dist/server/routes/paymentRoutes.js";
import { createHash } from "node:crypto";
import { legacyTransactionPayload, canonicalTransactionPayload } from "../dist/crypto/transactionSigning.js";
import { dispatchOutboxBatch } from "../dist/persistence/outboxWorker.js";
import { findReconciliationIssues, recordWalletOpeningBalance } from "../dist/persistence/reconciliation.js";
import { createEventStore } from "../dist/server/events.js";
import { runPaymentDemo } from "../dist/demo/runPayment.js";
import { createAuthResolver } from "../dist/server/authentication.js";
import { generateToken } from "../dist/auth/jwt.js";
import * as bcrypt from "bcryptjs";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

test("payment demo requires explicit non-production consent before touching a database", async () => {
  const mode = process.env.RAIL_DEMO_MODE;
  const environment = process.env.NODE_ENV;
  try {
    delete process.env.RAIL_DEMO_MODE;
    await assert.rejects(runPaymentDemo(), /DEMO_REQUIRES_EXPLICIT_NON_PRODUCTION_MODE/);
    process.env.RAIL_DEMO_MODE = "true";
    process.env.NODE_ENV = "production";
    await assert.rejects(runPaymentDemo(), /DEMO_REQUIRES_EXPLICIT_NON_PRODUCTION_MODE/);
  } finally {
    if (mode === undefined) delete process.env.RAIL_DEMO_MODE; else process.env.RAIL_DEMO_MODE = mode;
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  }
});

test("repeated payment demos reconcile isolated synthetic funds and remove only their own schemas", { skip: !databaseUrl }, async () => {
  const mode = process.env.RAIL_DEMO_MODE;
  const secret = process.env.RAIL_SIGNING_SECRET;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const inventory = () => admin.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'rail_demo_%' ORDER BY schema_name");
  try {
    const before = await inventory();
    process.env.RAIL_DEMO_MODE = "true";
    process.env.RAIL_SIGNING_SECRET = secret || "integration_demo_secret_01234567890123456789";
    for (let i = 0; i < 2; i++) {
      const demo = await runPaymentDemo();
      assert.equal(demo.result.status, "accepted");
      assert.deepEqual(demo.result, demo.cached);
      assert.equal(demo.reconciliationIssues, 0);
      assert.deepEqual(demo.wallets.map(wallet => [wallet.balance, wallet.reserved]), [["15000", "0"], ["85000", "0"]]);
    }
    assert.deepEqual((await inventory()).rows, before.rows);
  } finally {
    if (mode === undefined) delete process.env.RAIL_DEMO_MODE; else process.env.RAIL_DEMO_MODE = mode;
    if (secret === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = secret;
    await admin.end();
  }
});

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

test("concurrent migrations enforce local constraints and ignore foreign legacy tables", { skip: !databaseUrl }, async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const target = `ci_migration_${suffix}`;
  const foreign = `ci_legacy_${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${target}; CREATE SCHEMA ${foreign}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${target}` });
  try {
    await admin.query(`CREATE TABLE ${foreign}.api_keys (api_key TEXT, wallet_id TEXT);
      CREATE TABLE ${foreign}.api_keys_legacy (api_key TEXT, wallet_id TEXT);
      INSERT INTO ${foreign}.api_keys_legacy VALUES ('foreign_test_key', 'foreign_wallet')`);
    await Promise.all(Array.from({ length: 6 }, () => runMigrations(pool)));
    await Promise.all(Array.from({ length: 6 }, () => ensureOutboxSchema(pool)));
    await assert.rejects(pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ('invalid_wallet', -1)"), { code: "23514" });
    await assert.rejects(pool.query("INSERT INTO users (user_id, password_hash, wallet_id) VALUES ('orphan_user', 'test_hash', 'missing_wallet')"), { code: "23503" });
    const legacy = await admin.query(`SELECT * FROM ${foreign}.api_keys_legacy`);
    assert.equal(legacy.rows[0].api_key, "foreign_test_key");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM api_keys")).rows[0].count, 0);
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'api_keys'", [target]);
    assert.ok(columns.rows.some(row => row.column_name === "api_key_hash"));
    assert.ok(!columns.rows.some(row => row.column_name === "api_key"));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${target} CASCADE; DROP SCHEMA ${foreign} CASCADE`);
    await admin.end();
  }
});

test("failed schema migrations roll back new objects instead of leaving a partial runtime", { skip: !databaseUrl }, async () => {
  const schema = `ci_bad_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
  try {
    await pool.query("CREATE TABLE wallets (wallet_id TEXT PRIMARY KEY, balance BIGINT NOT NULL, reserved BIGINT DEFAULT 0, currency TEXT DEFAULT 'INR', updated_at TIMESTAMPTZ DEFAULT NOW())");
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ('invalid_historical_wallet', -1)");
    await assert.rejects(runMigrations(pool), { code: "23514" });
    assert.equal((await pool.query("SELECT to_regclass('rail_rate_limit_buckets') AS table_id")).rows[0].table_id, null);
    assert.equal((await pool.query("SELECT balance FROM wallets")).rows[0].balance, "-1");
    await pool.query("UPDATE wallets SET balance = 0");
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("legacy wallet baselines require explicit evidence and cannot be guessed or overwritten", { skip: !databaseUrl }, async () => {
  const schema = `ci_baseline_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
  try {
    await pool.query("CREATE TABLE wallets (wallet_id TEXT PRIMARY KEY, balance BIGINT NOT NULL, reserved BIGINT DEFAULT 0, currency TEXT DEFAULT 'INR', updated_at TIMESTAMPTZ DEFAULT NOW())");
    await pool.query("INSERT INTO wallets (wallet_id, balance) VALUES ('legacy_wallet', 5000)");
    await runMigrations(pool);
    assert.equal((await findReconciliationIssues(pool))[0].type, "missing_opening_balance");
    await assert.rejects(pool.query("UPDATE wallets SET balance = balance + 1"), /accounting_baseline_required/);
    await assert.rejects(recordWalletOpeningBalance(pool, "legacy_wallet", 4999, "statement:test"), /wallet_balance_equation_failed/);
    assert.equal((await pool.query("SELECT opening_balance_minor FROM wallets")).rows[0].opening_balance_minor, null);
    await recordWalletOpeningBalance(pool, "legacy_wallet", 5000, "statement:test");
    assert.deepEqual(await findReconciliationIssues(pool), []);
    const wallet = (await pool.query("SELECT balance, opening_balance_reference FROM wallets")).rows[0];
    assert.equal(wallet.balance, "5000");
    assert.equal(wallet.opening_balance_reference, "operator:statement:test");
    await assert.rejects(recordWalletOpeningBalance(pool, "legacy_wallet", 5000, "second:reference"), /baseline_already_recorded/);
    await assert.rejects(recordWalletOpeningBalance(pool, "legacy_wallet", NaN, "statement:test"), /invalid_opening_balance_record/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
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
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      await cleanup.query("DELETE FROM authorizations WHERE tx_id = $1", [input.txId]);
      await cleanup.query("DELETE FROM wallets WHERE wallet_id = ANY($1::text[])", [[sender, receiver]]);
      await cleanup.query("COMMIT");
    } finally {
      cleanup.release();
    }
    await pool.end();
    if (previousSecret === undefined) delete process.env.RAIL_SIGNING_SECRET;
    else process.env.RAIL_SIGNING_SECRET = previousSecret;
  }
});

async function paymentFixture(work) {
  // A single connection proves that execution never nests another checkout.
  const suffix = crypto.randomUUID();
  const schema = `ci_payment_${suffix.replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000, options: `-c search_path=${schema}` });
  const sender = `ci_sender_${suffix}`;
  const receiver = `ci_receiver_${suffix}`;
  const txId = `ci_payment_${suffix}`;
  const previousSecret = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = previousSecret || "integration_test_signing_secret_0123456789";
  try {
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
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
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousSecret === undefined) delete process.env.RAIL_SIGNING_SECRET;
    else process.env.RAIL_SIGNING_SECRET = previousSecret;
  }
}

test("event history filters wallets in SQL and pages equal-timestamp rows without duplicates", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    const store = createEventStore(() => pool);
    await makeEngine().execute(txn);
    const receiverEvents = await store.listVisibleEvents({ walletId: txn.receiverWalletId }, 100);
    assert.ok(receiverEvents.length > 0);
    assert.ok(receiverEvents.every(event => event.id && event.payload.receiverWalletId === txn.receiverWalletId));
    const time = "2026-10-10T00:00:00.000Z";
    for (let i = 0; i < 3; i++) await store.insertOutboxEvent({ type: "test.event", payload: { walletId: "wallet_target", ordinal: i }, occurredAt: time });
    await store.insertOutboxEvent({ type: "system.error", payload: { walletId: "wallet_target", message: "private" } });
    await pool.query(`INSERT INTO outbox(type, payload)
      SELECT 'test.noise', '{"walletId":"wallet_other"}'::jsonb FROM generate_series(1, 200)`);
    const first = await store.listVisibleEvents({ walletId: "wallet_target" }, 2);
    const second = await store.listVisibleEvents({ walletId: "wallet_target" }, 2, first.at(-1).id);
    assert.deepEqual([...first, ...second].map(event => event.payload.ordinal), [2, 1, 0]);
    assert.equal(new Set([...first, ...second].map(event => event.id)).size, 3);
    assert.deepEqual(await store.listVisibleEvents({ walletId: "wallet_outsider" }), []);
  });
});

test("event readers on another instance cannot observe an uncommitted notification", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool }) => {
    const reader = new Pool({ connectionString: databaseUrl, max: 1, options: pool.options.options });
    const client = await pool.connect();
    try {
      const store = createEventStore(() => reader);
      await client.query("BEGIN");
      await client.query("INSERT INTO outbox(type, payload) VALUES ('test.commit', '{\"walletId\":\"wallet_target\"}'::jsonb)");
      assert.deepEqual(await store.listVisibleEvents({ walletId: "wallet_target" }), []);
      await client.query("COMMIT");
      assert.equal((await store.listVisibleEvents({ walletId: "wallet_target" })).length, 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await reader.end();
    }
  });
});

test("logout-all revokes tokens across instances and prevents repeated revocation", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn }) => {
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = previousSecret || "integration_jwt_secret_01234567890123456789";
    try {
      await pool.query("INSERT INTO users(user_id, password_hash, wallet_id) VALUES ('user_session_test', $2, $1)",
        [txn.senderWalletId, await bcrypt.hash("session_test_password", 10)]);
      const first = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
      const second = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
      const token = generateToken("user_session_test", 0);
      const req = { method: "POST", headers: { authorization: `Bearer ${token}` } };
      assert.equal(await first.resolveAuthenticatedWallet(req), txn.senderWalletId);
      let result;
      const res = { writeHead() {}, end(body) { result = JSON.parse(body); } };
      await handleAuthRoutes(req, res, new URL("http://local/auth/logout-all"), { pool });
      assert.equal(result.sessionsRevoked, "all");
      await assert.rejects(second.resolveAuthenticatedWallet(req), { status: 401 });
      await assert.rejects(handleAuthRoutes(req, res, new URL("http://local/auth/logout-all"), { pool }), { status: 401 });
      assert.equal((await pool.query("SELECT auth_version FROM users WHERE user_id = 'user_session_test'")).rows[0].auth_version, 1);
      assert.equal(await second.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${generateToken("user_session_test", 1)}` } }), txn.senderWalletId);
      const login = Readable.from([JSON.stringify({ userId: "user_session_test", password: "session_test_password" })]);
      login.method = "POST";
      login.headers = { "content-type": "application/json" };
      login.socket = { remoteAddress: "127.0.0.1" };
      await handleAuthRoutes(login, { ...res, setHeader() {} }, new URL("http://local/auth/login"),
        { pool, config: loadServerConfig(), rateLimiter: new PostgresRateLimiter(pool) });
      assert.equal(await second.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${result.token}` } }), txn.senderWalletId);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    }
  });
});

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

test("database commit guards reject incomplete or mismatched payments and roll back money", { skip: !databaseUrl }, async () => {
  for (const fault of ["one_entry", "wrong_currency", "wrong_receiver", "wrong_amount", "missing_execution", "missing_usage", "unused_authorization", "wrong_replay"]) {
    await paymentFixture(async ({ pool, txn, store, makeEngine }) => {
      const faultyPipeline = async ctx => {
        const client = ctx.dbClient;
        if (fault !== "unused_authorization") await claimAuthorizationForExecution(client, txn.authorizationId, txn);
        if (fault !== "missing_usage") await client.query("INSERT INTO authorization_usage (auth_id, tx_id) VALUES ($1,$2)", [txn.authorizationId, txn.txId]);
        await consumeReservation(client, txn.senderWalletId, txn.amountMinor, txn.currency);
        await creditWallet(client, txn.receiverWalletId, txn.amountMinor, txn.currency);
        const amount = fault === "wrong_amount" ? txn.amountMinor + 1 : txn.amountMinor;
        const currency = fault === "wrong_currency" ? "USD" : txn.currency;
        await client.query("INSERT INTO ledger_entries (tx_id, wallet_id, entry_type, amount_minor, currency) VALUES ($1,$2,'debit',$3,$4)", [txn.txId, txn.senderWalletId, amount, currency]);
        if (fault !== "one_entry") await client.query("INSERT INTO ledger_entries (tx_id, wallet_id, entry_type, amount_minor, currency) VALUES ($1,$2,'credit',$3,$4)",
          [txn.txId, fault === "wrong_receiver" ? txn.senderWalletId : txn.receiverWalletId, amount, currency]);
        const result = { status: "accepted", ledgerEntryId: `leg_${txn.txId}` };
        if (fault !== "missing_execution") await client.query("INSERT INTO rail_payment_executions (tx_id, idempotency_key, request_fingerprint, result_json) VALUES ($1,$2,$3,$4)",
          [txn.txId, txn.idempotencyKey, createHash("sha256").update(canonicalTransactionPayload(txn)).digest("hex"), fault === "wrong_replay" ? { ...result, ledgerEntryId: "incorrect_result" } : result]);
        ctx.result = result;
      };
      await assert.rejects(makeEngine(store, faultyPipeline).execute(txn), { code: "23514" }, fault);
      const sender = (await pool.query("SELECT balance, reserved FROM wallets WHERE wallet_id = $1", [txn.senderWalletId])).rows[0];
      assert.equal(Number(sender.balance), 7500, fault);
      assert.equal(Number(sender.reserved), 2500, fault);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM ledger_entries")).rows[0].count, 0, fault);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM rail_idempotency")).rows[0].count, 0, fault);
      assert.equal((await makeEngine().execute(txn)).status, "accepted", fault);
    });
  }
});

test("a payment cannot commit without its durable replay record", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    const incompleteStore = {
      async dedupe(_key, _fingerprint, run) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await run(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
    await assert.rejects(makeEngine(incompleteStore).execute(txn), /payment_commit_record_missing/);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM rail_payment_executions")).rows[0].count, 0);
    assert.equal((await makeEngine().execute(txn)).status, "accepted");
  });
});

test("posted payment history and used authorization financial fields cannot be rewritten", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    await assert.rejects(pool.query("INSERT INTO authorization_usage (auth_id, tx_id) VALUES ($1, 'mismatched_transaction')", [txn.authorizationId]), { code: "23503" });
    const engine = makeEngine();
    const result = await engine.execute(txn);
    for (const sql of [
      "UPDATE ledger_entries SET amount_minor = amount_minor + 1 WHERE tx_id = $1",
      "DELETE FROM ledger_entries WHERE tx_id = $1",
      "DELETE FROM authorization_usage WHERE tx_id = $1",
      "UPDATE rail_payment_executions SET result_json = '{}' WHERE tx_id = $1",
      "DELETE FROM rail_payment_executions WHERE tx_id = $1",
      "UPDATE authorizations SET amount_minor = amount_minor + 1 WHERE tx_id = $1",
      "UPDATE authorizations SET status = 'issued' WHERE tx_id = $1",
    ]) await assert.rejects(pool.query(sql, [txn.txId]), { code: "23514" });
    assert.deepEqual(await engine.execute(txn), result);
  });
});

test("wallet equations prevent unrecorded credits, unmatched reservations and baseline rewrites", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    assert.deepEqual(await findReconciliationIssues(pool), []);
    for (const sql of [
      "UPDATE wallets SET balance = balance + 1 WHERE wallet_id = $1",
      "UPDATE wallets SET balance = balance - 1, reserved = reserved + 1 WHERE wallet_id = $1",
      "UPDATE wallets SET opening_balance_minor = opening_balance_minor + 1 WHERE wallet_id = $1",
      "UPDATE wallets SET currency = 'USD' WHERE wallet_id = $1",
    ]) await assert.rejects(pool.query(sql, [txn.senderWalletId]), { code: "23514" });
    assert.equal((await makeEngine().execute(txn)).status, "accepted");
    assert.deepEqual(await findReconciliationIssues(pool), []);
  });
});

test("reconciliation sees coherent snapshots while payment execution commits", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    const readers = new Pool({ connectionString: databaseUrl, max: 4, options: pool.options.options });
    try {
      const results = await Promise.all([makeEngine().execute(txn), ...Array.from({ length: 12 }, () => findReconciliationIssues(readers))]);
      assert.equal(results[0].status, "accepted");
      assert.ok(results.slice(1).every(issues => issues.length === 0));
    } finally {
      await readers.end();
    }
  });
});

test("reconciliation flags historical wallet drift and truncation without repairing data", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    await makeEngine().execute(txn);
    await pool.query("ALTER TABLE wallets DISABLE TRIGGER rail_wallet_commit_check");
    await pool.query("UPDATE wallets SET balance = balance + 1");
    await pool.query("ALTER TABLE wallets ENABLE TRIGGER rail_wallet_commit_check");
    const issues = await findReconciliationIssues(pool);
    assert.equal(issues.filter(issue => issue.type === "wallet_balance_mismatch").length, 2);
    assert.equal((await findReconciliationIssues(pool, 1)).at(-1).type, "scan_truncated");
    assert.equal(Number((await pool.query("SELECT balance FROM wallets WHERE wallet_id = $1", [txn.senderWalletId])).rows[0].balance), 7501);
    await assert.rejects(findReconciliationIssues(pool, 0), /invalid_reconciliation_limit/);
  });
});

test("historical cross-currency ledger pairs are reported even when their numeric totals balance", { skip: !databaseUrl }, async () => {
  await paymentFixture(async ({ pool, txn, makeEngine }) => {
    await makeEngine().execute(txn);
    await pool.query("ALTER TABLE ledger_entries DISABLE TRIGGER rail_ledger_immutable");
    await pool.query("UPDATE ledger_entries SET currency = 'USD' WHERE entry_type = 'credit'");
    await pool.query("ALTER TABLE ledger_entries ENABLE TRIGGER rail_ledger_immutable");
    const types = (await findReconciliationIssues(pool)).map(issue => issue.type);
    for (const type of ["unbalanced_ledger", "wallet_currency_mismatch", "authorization_ledger_mismatch", "incomplete_payment"]) assert.ok(types.includes(type), type);
    await assert.rejects(recordWalletOpeningBalance(pool, txn.receiverWalletId, 0, "statement:test"), /historical_accounting_review_required/);
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
    // Simulate legacy corruption only in this disposable schema, using its owner role.
    await pool.query("ALTER TABLE wallets DISABLE TRIGGER rail_wallet_commit_check");
    await pool.query("UPDATE wallets SET balance = 10000, reserved = 0 WHERE wallet_id = 'expiry_sender'");
    await pool.query("ALTER TABLE wallets ENABLE TRIGGER rail_wallet_commit_check");
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
