import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { Pool } from "pg";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { AuditBatchStore } from "../dist/persistence/auditBatches.js";
import { TransactionEvidenceStore } from "../dist/persistence/transactionEvidence.js";
import { RiskProtectionStore } from "../dist/persistence/riskProtection.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { commitProtectedEvidence, verifyAuditProof } from "../dist/crypto/auditCommitment.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { PostgresOfflineTokenStore } from "../dist/persistence/postgresOfflineTokenStore.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { createAuthorization } from "../dist/stages/authorizationStage.js";
import { handlePaymentRoutes } from "../dist/server/routes/paymentRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";
import { RequestError } from "../dist/server/http.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
function keys(keyId) { return { keyId, encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) }; }
function ringJson(key) { return JSON.stringify({ activeKeyId: key.keyId, keys: [{ keyId: key.keyId,
  encryptionKey: key.encryptionKey.toString("base64"), authenticationKey: key.authenticationKey.toString("base64") }] }); }

async function fixture(work, max = 1) {
  const schema = `ci_audit_${randomUUID().replaceAll("-", "")}`, admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
  const original = { RAIL_SIGNING_SECRET: process.env.RAIL_SIGNING_SECRET, RAIL_REQUIRE_TX_SIGNATURE: process.env.RAIL_REQUIRE_TX_SIGNATURE };
  process.env.RAIL_SIGNING_SECRET = "audit_test_secret_01234567890123456789"; process.env.RAIL_REQUIRE_TX_SIGNATURE = "false";
  const paymentKey = keys("audit_payment_v1"), riskKey = keys("audit_risk_v1");
  const evidence = new TransactionEvidenceStore(new TransactionKeyRing(paymentKey.keyId, [paymentKey]));
  const risk = new RiskProtectionStore(new TransactionKeyRing(riskKey.keyId, [riskKey]));
  try {
    await runMigrations(pool); await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id, balance) VALUES ('audit_sender',1000000),('audit_receiver',0),('audit_other',0)");
    const tokens = new PostgresOfflineTokenStore(pool);
    const engine = (protectedPayment = true, protectedRisk = true) => new PaymentPipelineEngine({
      idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer, dlq: new MemoryDeadLetterQueue(),
      pipeline: buildHardenedPaymentPipeline(noopTracer, tokens, undefined, undefined, protectedRisk ? risk : undefined),
      evidence: protectedPayment ? evidence : undefined, riskProtectionRequired: protectedRisk,
    });
    const transaction = async (amountMinor = 100, channel = "online") => {
      const txId = `audit_${randomUUID()}`, auth = await createAuthorization({ txId, senderWalletId: "audit_sender",
        receiverWalletId: "audit_receiver", amountMinor, currency: "INR" }, pool);
      const token = channel === "online" ? undefined : await tokens.issue({ walletId: "audit_sender", deviceId: "audit_device", amountCapMinor: 5000 });
      return { txId, idempotencyKey: `idem_${txId}`, authorizationId: auth.authId, senderWalletId: "audit_sender",
        receiverWalletId: "audit_receiver", amountMinor, currency: "INR", channel, createdAt: new Date().toISOString(),
        ...(token ? { deviceId: "audit_device", offlineTokenId: token.tokenId } : {}) };
    };
    const audit = new AuditBatchStore(pool, evidence, risk);
    await work({ pool, schema, evidence, risk, paymentKey, riskKey, engine, transaction, audit });
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
}
const integration = { skip: !databaseUrl };

test("durable audit batches bind odd-sized online/offline evidence and preserve financial state and replay", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    const txns = [];
    for (let i = 0; i < 5; i++) { const txn = await transaction(100 + i, i % 2 ? "nfc" : "online"); txns.push(txn); await engine(true, i !== 0).execute(txn); }
    assert.equal((await audit.status(txns[0].txId, "audit_sender")).status, "pending_batch");
    const money = (await pool.query("SELECT * FROM wallets ORDER BY wallet_id")).rows;
    const batch = await audit.createBatch(); assert.equal(batch.leafCount, 5); assert.equal(batch.publication, "unanchored");
    for (const txn of txns) {
      const response = await audit.status(txn.txId, "audit_receiver");
      assert.equal(response.status, "batched"); assert.equal(response.verification, "local_only");
      assert.equal(response.root, batch.root);
      assert.equal(verifyAuditProof(response.leaf, response.proof, batch.root), true);
      assert.equal(response.leaf, commitProtectedEvidence(response.paymentCommitment, response.riskCommitment));
      assert.deepEqual(await engine().execute(txn), { status: "accepted", ledgerEntryId: `leg_${txn.txId}` });
    }
    assert.equal((await audit.status(txns[0].txId, "audit_sender")).riskCommitment, null);
    assert.deepEqual(await audit.createBatch(), { status: "empty" });
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 0);
    assert.deepEqual((await pool.query("SELECT * FROM wallets ORDER BY wallet_id")).rows, money);
  });
});

test("concurrent bounded audit batchers include each payment once and immutable membership survives retries", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    for (let i = 0; i < 7; i++) await engine().execute(await transaction());
    const results = await Promise.all(Array.from({ length: 8 }, () => audit.createBatch(2)));
    assert.equal(results.filter(item => item.status === "created").length, 4);
    assert.equal(results.filter(item => item.status === "empty").length, 4);
    const members = (await pool.query("SELECT * FROM rail_audit_memberships")).rows;
    assert.equal(new Set(members.map(row => row.tx_id)).size, 7);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 0);
    await assert.rejects(pool.query("DELETE FROM rail_audit_batches"), /posted_payment_history_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_audit_memberships SET leaf_index = 0"), /posted_payment_history_is_immutable/);
  }, 4);
});

test("audit batches exclude legacy plaintext payments and reject invalid limits without SQL work", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    for (const limit of [0, -1, 257, 1.5, NaN, "1"]) await assert.rejects(audit.createBatch(limit), /INVALID_AUDIT_BATCH_LIMIT/);
    const txn = await transaction(); await engine(false, false).execute(txn);
    assert.equal((await audit.status(txn.txId, "audit_sender")).status, "legacy_unprotected");
    assert.deepEqual(await audit.createBatch(), { status: "empty" });
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 0);
  });
});

test("partial audit membership failure restores the queue without changing already committed money", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    for (let i = 0; i < 3; i++) await engine().execute(await transaction());
    const money = (await pool.query("SELECT * FROM wallets ORDER BY wallet_id")).rows;
    await pool.query(`CREATE FUNCTION fail_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.leaf_index = 1 THEN RAISE EXCEPTION 'audit_membership_write_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_membership BEFORE INSERT ON rail_audit_memberships FOR EACH ROW EXECUTE FUNCTION fail_membership()`);
    await assert.rejects(audit.createBatch(), /audit_membership_write_failure/);
    for (const table of ["rail_audit_batches", "rail_audit_memberships"]) assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 3);
    assert.deepEqual((await pool.query("SELECT * FROM wallets ORDER BY wallet_id")).rows, money);
    await pool.query("DROP TRIGGER fail_membership ON rail_audit_memberships");
    assert.equal((await audit.createBatch()).leafCount, 3);
  });
});

test("deferred audit commit rejection cannot report a batch or remove pending work", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    await engine().execute(await transaction());
    await pool.query(`CREATE FUNCTION fail_batch_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_final_commit_failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_batch_commit AFTER INSERT ON rail_audit_batches DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fail_batch_commit()`);
    await assert.rejects(audit.createBatch(), /audit_final_commit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_audit_batches")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 1);
    await pool.query("DROP TRIGGER fail_batch_commit ON rail_audit_batches");
    assert.equal((await audit.createBatch()).leafCount, 1);
  });
});

test("missing audit decryption keys halt batching and retained rotation recovers the original evidence", integration, async () => {
  await fixture(async ({ pool, audit, evidence, risk, paymentKey, engine, transaction }) => {
    const txn = await transaction(); await engine().execute(txn);
    const next = keys("audit_payment_v2");
    const lost = new AuditBatchStore(pool, new TransactionEvidenceStore(new TransactionKeyRing(next.keyId, [next])), risk);
    assert.deepEqual(await lost.status(txn.txId, "audit_sender"), { txId: txn.txId, status: "verification_unavailable", reason: "key_unavailable" });
    await assert.rejects(lost.createBatch(), /transaction_evidence_key_unavailable/);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 1);
    const retained = new AuditBatchStore(pool, new TransactionEvidenceStore(new TransactionKeyRing(next.keyId, [paymentKey, next])), risk);
    assert.equal((await retained.createBatch()).leafCount, 1);
    assert.equal((await audit.status(txn.txId, "audit_sender")).status, "batched");
  });
});

test("audit batching refuses tampered payment or required risk envelopes without dropping poisoned records", integration, async () => {
  for (const [table, trigger] of [["rail_transaction_evidence", "rail_evidence_immutable"], ["rail_protected_risk", "rail_protected_risk_immutable"]]) {
    await fixture(async ({ pool, audit, engine, transaction }) => {
      const txn = await transaction(); await engine().execute(txn);
      const original = (await pool.query(`SELECT envelope FROM ${table} WHERE tx_id = $1`, [txn.txId])).rows[0].envelope;
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await pool.query(`UPDATE ${table} SET envelope = jsonb_set(envelope, '{mac}', to_jsonb($2::text)) WHERE tx_id = $1`, [txn.txId, randomBytes(32).toString("base64")]);
      assert.equal((await audit.status(txn.txId, "audit_sender")).status, "verification_unavailable");
      await assert.rejects(audit.createBatch());
      assert.equal((await pool.query("SELECT * FROM rail_audit_batches")).rowCount, 0);
      assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 1);
      await pool.query(`UPDATE ${table} SET envelope = $2::jsonb WHERE tx_id = $1`, [txn.txId, JSON.stringify(original)]);
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      assert.equal((await audit.createBatch()).leafCount, 1);
    });
  }
});

test("audit readers suppress altered batch roots and proofs rather than returning false verification", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    const txns = [await transaction(), await transaction()];
    for (const txn of txns) await engine().execute(txn);
    const batch = await audit.createBatch(), before = await audit.status(txns[0].txId, "audit_sender");
    before.proof.siblings[0] = "0".repeat(64);
    assert.notDeepEqual((await audit.status(txns[0].txId, "audit_sender")).proof, before.proof);
    await pool.query("ALTER TABLE rail_audit_batches DISABLE TRIGGER rail_audit_batch_immutable");
    await pool.query("UPDATE rail_audit_batches SET root = $1", ["f".repeat(64)]);
    assert.deepEqual(await audit.status(txns[0].txId, "audit_sender"), { txId: txns[0].txId, status: "verification_unavailable", reason: "verification_failed" });
    await pool.query("UPDATE rail_audit_batches SET root = $1", [batch.root]);
    await pool.query("ALTER TABLE rail_audit_batches ENABLE TRIGGER rail_audit_batch_immutable");
    await pool.query("ALTER TABLE rail_audit_memberships DISABLE TRIGGER rail_audit_membership_immutable");
    await pool.query("UPDATE rail_audit_memberships SET proof = jsonb_set(proof,'{siblings,0}',to_jsonb($2::text)) WHERE tx_id = $1", [txns[0].txId, "f".repeat(64)]);
    assert.equal((await audit.status(txns[0].txId, "audit_sender")).status, "verification_unavailable");
    await pool.query("ALTER TABLE rail_audit_memberships ENABLE TRIGGER rail_audit_membership_immutable");
  });
});

test("database rejects incomplete batches, missing queue consumption and unbound ciphertext membership", integration, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = await transaction(); await engine().execute(txn);
    await assert.rejects(pool.query("DELETE FROM rail_audit_pending"), /audit_queue_requires_membership/);
    await assert.rejects(pool.query("INSERT INTO rail_audit_batches(batch_id,root,leaf_count) VALUES ($1,$2,1)", [randomUUID(), "a".repeat(64)]), /audit_batch_incomplete_or_unbound/);
    const evidence = (await pool.query("SELECT commitment FROM rail_transaction_evidence")).rows[0].commitment;
    const risk = (await pool.query("SELECT commitment FROM rail_protected_risk")).rows[0].commitment;
    for (const omitQueueConsumption of [false, true]) {
      const client = await pool.connect(), batchId = randomUUID();
      try {
        await client.query("BEGIN");
        const count = omitQueueConsumption ? 1 : 2;
        await client.query("INSERT INTO rail_audit_batches(batch_id,root,leaf_count) VALUES ($1,$2,$3)", [batchId, "a".repeat(64), count]);
        await client.query(`INSERT INTO rail_audit_memberships(tx_id,batch_id,leaf_index,leaf_hash,payment_commitment,risk_commitment,proof)
          VALUES ($1,$2,0,$3,$4,$5,$6::jsonb)`, [txn.txId, batchId, commitProtectedEvidence(evidence, risk), evidence, risk,
          JSON.stringify({ leafIndex: 0, leafCount: count, siblings: count === 1 ? [] : ["b".repeat(64)] })]);
        if (!omitQueueConsumption) await client.query("DELETE FROM rail_audit_pending");
        await assert.rejects(client.query("COMMIT"), /audit_batch_incomplete_or_unbound/);
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); const batchId = randomUUID();
      await client.query("INSERT INTO rail_audit_batches(batch_id,root,leaf_count) VALUES ($1,$2,1)", [batchId, "a".repeat(64)]);
      await assert.rejects(client.query(`INSERT INTO rail_audit_memberships(tx_id,batch_id,leaf_index,leaf_hash,payment_commitment,risk_commitment,proof)
        VALUES ($1,$2,0,$3,$4,$5,$6::jsonb)`, [txn.txId, batchId, "a".repeat(64), "f".repeat(64), risk,
        JSON.stringify({ leafIndex: 0, leafCount: 1, siblings: [] })]), { code: "23503" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

test("audit API masks unauthorized records, protects proof privacy and shares participant read quotas", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    const txn = await transaction(); await engine().execute(txn); await audit.createBatch();
    const limiter = new PostgresRateLimiter(pool);
    const call = async (walletId, txId = txn.txId, ip = "192.0.2.1") => {
      const req = Readable.from([]); req.method = "GET"; req.headers = {}; req.socket = { remoteAddress: ip };
      const headers = {}, res = { setHeader(key, value) { headers[key] = value; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      await handlePaymentRoutes(req, res, new URL(`http://localhost/v1/payments/${txId}/audit`), {
        pool, auditStore: audit, config: loadServerConfig(), rateLimiter: limiter,
        authResolver: { async resolveAuthenticatedWallet() { return walletId; } },
      });
      return { ...res, headers };
    };
    await assert.rejects(call("audit_other"), { status: 404 });
    await assert.rejects(call("audit_other", "missing_payment"), { status: 404 });
    await assert.rejects(call("audit_sender", "invalid%ZZ"), { status: 400 });
    const response = await call("audit_sender");
    assert.equal(response.status, 200); assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.body.audit.publication, "unanchored");
    for (const forbidden of ["audit_receiver", "audit_other", "ciphertext", "encryptionKey", "modelVersion", "amountMinor"])
      assert.ok(!JSON.stringify(response.body).includes(forbidden));
    // The malformed authenticated request counts toward the same wallet-wide allowance.
    for (let i = 1; i < 29; i++) await call("audit_sender", txn.txId, `192.0.2.${i + 1}`);
    await assert.rejects(call("audit_sender", txn.txId, "192.0.2.100"), { status: 429 });
  });
});

test("failed financial audit enqueue rolls back money, token spend, evidence, risk and replay", integration, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = await transaction(100, "nfc");
    await pool.query(`CREATE FUNCTION fail_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_enqueue_failure'; END $$;
      CREATE TRIGGER fail_enqueue BEFORE INSERT ON rail_audit_pending FOR EACH ROW EXECUTE FUNCTION fail_enqueue()`);
    await assert.rejects(engine().execute(txn), /audit_enqueue_failure/);
    for (const table of ["ledger_entries", "rail_transaction_evidence", "rail_protected_risk", "rail_audit_pending", "rail_idempotency", "rail_offline_spends"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    assert.equal((await pool.query("SELECT remaining_minor FROM rail_offline_tokens")).rows[0].remaining_minor, "5000");
    await pool.query("DROP TRIGGER fail_enqueue ON rail_audit_pending");
    assert.equal((await engine().execute(txn)).status, "accepted");
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 1);
  });
});

test("audit source limits run before authentication and cannot be reset by rotating invalid credentials", integration, async () => {
  await fixture(async ({ pool, audit }) => {
    let resolutions = 0;
    const context = { pool, auditStore: audit, config: loadServerConfig(), rateLimiter: new PostgresRateLimiter(pool),
      authResolver: { async resolveAuthenticatedWallet() { resolutions++; throw new RequestError(401, "unauthorized", "invalid credentials"); } } };
    for (let i = 0; i <= 30; i++) {
      const req = Readable.from([]); req.method = "GET"; req.headers = { "x-rail-api-key": `invalid_key_${i}` };
      req.socket = { remoteAddress: "192.0.2.200" };
      const headers = {}, res = { setHeader(key, value) { headers[key] = value; } };
      await assert.rejects(handlePaymentRoutes(req, res, new URL("http://localhost/v1/payments/missing_payment/audit"), context),
        { status: i < 30 ? 401 : 429 });
      if (i === 30) assert.ok(Number(headers["Retry-After"]) > 0);
    }
    assert.equal(resolutions, 30);
  });
});

test("audit migration queues existing protected evidence without rewriting ciphertext or duplicating batched history", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    const txn = await transaction(); await engine().execute(txn);
    const before = (await pool.query("SELECT * FROM rail_transaction_evidence")).rows;
    await pool.query("DROP TABLE rail_audit_pending");
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 1);
    assert.deepEqual((await pool.query("SELECT * FROM rail_transaction_evidence")).rows, before);
    await audit.createBatch(); await runMigrations(pool);
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 0);
  });
});

test("audit worker backend termination restores partial batches and queued work for safe retry", integration, async () => {
  await fixture(async ({ pool, audit, engine, transaction }) => {
    for (let i = 0; i < 2; i++) await engine().execute(await transaction());
    await pool.query(`CREATE FUNCTION terminate_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.leaf_index = 1 THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NEW; END $$;
      CREATE TRIGGER terminate_batch BEFORE INSERT ON rail_audit_memberships FOR EACH ROW EXECUTE FUNCTION terminate_batch()`);
    await assert.rejects(audit.createBatch());
    assert.equal((await pool.query("SELECT * FROM rail_audit_pending")).rowCount, 2);
    assert.equal((await pool.query("SELECT * FROM rail_audit_batches")).rowCount, 0);
    await pool.query("DROP TRIGGER terminate_batch ON rail_audit_memberships");
    assert.equal((await audit.createBatch()).leafCount, 2);
  });
});

test("finite audit CLI persists a batch, safely retries and hides private SQL failures", integration, async () => {
  await fixture(async ({ pool, schema, paymentKey, riskKey, engine, transaction }) => {
    await engine().execute(await transaction());
    const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
    const env = { ...process.env, DATABASE_URL: url.toString(), RAIL_EVIDENCE_KEY_RING: ringJson(paymentKey),
      RAIL_RISK_RECORD_KEY_RING: ringJson(riskKey), RAIL_AUDIT_BATCH_SIZE: "128" };
    const run = custom => execFileSync(process.execPath, ["dist/persistence/runAuditBatch.js"], { env: { ...env, ...custom }, encoding: "utf8", stdio: "pipe" });
    const parse = raw => JSON.parse(raw.trim().split("\n").findLast(line => line.startsWith("{")));
    const batch = parse(run()); assert.equal(batch.status, "created"); assert.equal(batch.publication, "unanchored");
    assert.deepEqual(parse(run()), { status: "empty" });
    assert.throws(() => run({ RAIL_AUDIT_BATCH_SIZE: "257" }), error => error.status === 1 && error.stderr.trim() === "audit_batch_failed");
    const missing = new URL(databaseUrl); missing.searchParams.set("options", "-c search_path=private_missing_schema");
    assert.throws(() => run({ DATABASE_URL: missing.toString() }), error => error.status === 1 &&
      error.stderr.trim() === "audit_batch_failed" && !error.stderr.includes("private_missing_schema"));
    assert.equal((await pool.query("SELECT * FROM rail_audit_memberships")).rowCount, 1);
  });
});
