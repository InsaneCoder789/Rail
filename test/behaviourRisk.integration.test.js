import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { Pool } from "pg";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { createAuthorization } from "../dist/stages/authorizationStage.js";
import { explainBehaviour, persistBehaviourObservation, readBehaviourObservation } from "../dist/risk/behaviourRisk.js";
import { handlePaymentRoutes } from "../dist/server/routes/paymentRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const model = { schemaVersion: 1, modelVersion: "synthetic-risk-fixture", datasetId: "test-only", currency: "INR",
  synthetic: true, trainingRows: 20, weights: [-1, 1, 0.5] };

async function fixture(work) {
  const schema = `ci_behaviour_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
  const secret = process.env.RAIL_SIGNING_SECRET;
  const required = process.env.RAIL_REQUIRE_TX_SIGNATURE;
  process.env.RAIL_SIGNING_SECRET = "behaviour_test_secret_01234567890123456789";
  process.env.RAIL_REQUIRE_TX_SIGNATURE = "false";
  try {
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id, balance) VALUES ('risk_sender', 1000000), ('risk_receiver', 0), ('risk_other', 0)");
    const engine = (riskModel, after) => {
      const pipeline = buildHardenedPaymentPipeline(noopTracer, undefined, riskModel);
      return new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
        dlq: new MemoryDeadLetterQueue(), pipeline: async ctx => { await pipeline(ctx); await after?.(ctx); } });
    };
    const transaction = async (amountMinor = 100, receiverWalletId = "risk_receiver", createdAt = new Date().toISOString()) => {
      const txId = `risk_${randomUUID()}`;
      const auth = await createAuthorization({ txId, senderWalletId: "risk_sender", receiverWalletId, amountMinor, currency: "INR" }, pool);
      return { txId, idempotencyKey: `idem_${txId}`, authorizationId: auth.authId, senderWalletId: "risk_sender",
        receiverWalletId, amountMinor, currency: "INR", channel: "online", createdAt };
    };
    await work({ pool, engine, transaction });
  } finally {
    if (secret === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = secret;
    if (required === undefined) delete process.env.RAIL_REQUIRE_TX_SIGNATURE; else process.env.RAIL_REQUIRE_TX_SIGNATURE = required;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("behaviour policy explicitly distinguishes cold start and unexplained device identity", () => {
  const features = { historyCount: 0, historyTruncated: false, recentCount: 0, receiverSeen: false,
    amountRatio: null, amountZScore: null, agentBudgetExposure: null };
  assert.deepEqual(explainBehaviour(features), { level: "insufficient_history", reasons: ["insufficient_history", "receiver_not_seen_in_sample"] });
  assert.equal(explainBehaviour({ ...features, historyCount: 5, receiverSeen: true }).level, "normal");
  assert.equal(explainBehaviour({ ...features, historyCount: 5, historyTruncated: true }).level, "insufficient_history");
  assert.ok(explainBehaviour({ ...features, agentBudgetExposure: 0.9 }).reasons.includes("high_agent_budget_exposure"));
});

test("behaviour snapshots use database time and exclude the current or caller-invented history", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = { ...await transaction(100, "risk_receiver", "2099-01-01T00:00:00.000Z"), riskScore: 0, historyCount: 999, deviceId: "claimed_device" };
    assert.equal((await engine().execute(txn)).status, "accepted");
    const row = (await pool.query("SELECT * FROM rail_risk_observations")).rows[0];
    assert.equal(row.feature_snapshot.historyCount, 0);
    assert.equal(row.feature_snapshot.meanAmountMinor, null);
    assert.equal(row.feature_snapshot.deviceChange, "not_assessed");
    assert.ok(new Date(row.observed_at).getFullYear() < 2099);
    assert.equal(row.model_status, "not_configured");
    assert.equal(row.prediction, null);
    assert.equal(row.assessment.mode, "shadow");
  });
});

test("behaviour bounds sampled history and marks lower-bound velocity instead of inventing complete coverage", async () => {
  const now = new Date();
  let calls = 0, saved;
  const client = { async query(sql, params) {
    calls++;
    if (calls === 1) {
      assert.match(sql, /LIMIT 1001/);
      assert.match(sql, /interval '30 days'/);
      return { rows: Array.from({ length: 1001 }, () => ({ now, amount_minor: "100", receiver_wallet_id: "receiver", committed_at: now })) };
    }
    if (calls === 2) return { rows: [] };
    saved = JSON.parse(params[3]);
    return { rows: [] };
  } };
  await persistBehaviourObservation(client, { txId: "sample_test_001", idempotencyKey: "sample_idem_001", senderWalletId: "sender",
    receiverWalletId: "receiver", amountMinor: 100, currency: "INR", channel: "online", createdAt: now.toISOString() });
  assert.equal(saved.historyCount, 1000);
  assert.equal(saved.recentCount, 1000);
  assert.equal(saved.historyTruncated, true);
  assert.equal(saved.meanAmountMinor, 100);
  assert.equal(saved.amountZScore, null);
});

test("behaviour observes payment velocity, amount deviation and recipient familiarity without blocking money", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const runtime = engine();
    for (let i = 0; i < 6; i++) await runtime.execute(await transaction());
    const next = await transaction(900, "risk_other");
    assert.equal((await runtime.execute(next)).status, "accepted");
    const row = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [next.txId])).rows[0];
    assert.equal(row.feature_snapshot.historyCount, 6);
    assert.equal(row.feature_snapshot.recentCount, 6);
    assert.equal(row.feature_snapshot.meanAmountMinor, 100);
    assert.equal(row.feature_snapshot.amountRatio, 9);
    assert.equal(row.feature_snapshot.amountZScore, null);
    assert.equal(row.feature_snapshot.receiverSeen, false);
    assert.equal(row.assessment.level, "review");
    assert.ok(row.assessment.reasons.includes("recent_payment_velocity"));
    assert.ok(row.assessment.reasons.includes("amount_above_history"));
  });
});

test("behaviour keeps a stable validated model snapshot and immutable result across replay or rollback models", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const mutable = { ...model, weights: [...model.weights] };
    const runtime = engine(mutable);
    mutable.modelVersion = "mutated";
    mutable.weights[0] = 100;
    const txn = await transaction();
    const receipt = await runtime.execute(txn);
    const before = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [txn.txId])).rows[0];
    assert.equal(before.model_version, model.modelVersion);
    assert.equal(before.synthetic, true);
    assert.equal(before.prediction.contributions[0], -1);
    assert.match(before.model_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await engine({ ...model, modelVersion: "replacement", weights: [1, 2, 3] }).execute(txn), receipt);
    assert.deepEqual((await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [txn.txId])).rows[0], before);
    await assert.rejects(pool.query("UPDATE rail_risk_observations SET model_version = 'forged' WHERE tx_id = $1", [txn.txId]), /posted_payment_history_is_immutable/);
    await assert.rejects(pool.query("DELETE FROM rail_risk_observations WHERE tx_id = $1", [txn.txId]), /posted_payment_history_is_immutable/);
  });
});

test("behaviour reports a currency mismatch rather than fabricating a model probability", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    await engine({ ...model, currency: "USD" }).execute(await transaction());
    const row = (await pool.query("SELECT * FROM rail_risk_observations")).rows[0];
    assert.equal(row.model_status, "currency_mismatch");
    assert.equal(row.prediction, null);
    assert.equal(row.model_version, null);
  });
});

test("behaviour histories serialize concurrent transfers instead of losing completed predecessors", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txns = [];
    for (let i = 0; i < 5; i++) txns.push(await transaction());
    const runtime = engine();
    await Promise.all(txns.map(txn => runtime.execute(txn)));
    const rows = (await pool.query("SELECT feature_snapshot FROM rail_risk_observations")).rows;
    assert.deepEqual(rows.map(row => row.feature_snapshot.historyCount).sort((a,b) => a-b), [0,1,2,3,4]);
    assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "10");
  });
});

test("behaviour write failures roll back payment effects and allow legitimate retries", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = await transaction();
    await pool.query(`CREATE FUNCTION fail_risk() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_risk_failure'; END $$;
      CREATE TRIGGER fail_risk BEFORE INSERT ON rail_risk_observations FOR EACH ROW EXECUTE FUNCTION fail_risk()`);
    await assert.rejects(engine().execute(txn), /injected_risk_failure/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_risk_observations")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_idempotency")).rowCount, 0);
    await pool.query("DROP TRIGGER fail_risk ON rail_risk_observations");
    assert.equal((await engine().execute(txn)).status, "accepted");
  });
});

test("behaviour deferred checks refuse success if required observation disappears before commit", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    // Simulate a privileged faulty writer, without weakening the final payment invariant.
    await pool.query("ALTER TABLE rail_risk_observations DISABLE TRIGGER rail_risk_immutable");
    const txn = await transaction();
    await assert.rejects(engine(undefined, async ctx => {
      assert.equal(ctx.result.status, "accepted");
      await ctx.dbClient.query("DELETE FROM rail_risk_observations WHERE tx_id = $1", [txn.txId]);
    }).execute(txn), /payment_risk_observation_missing/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_payment_executions")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_idempotency")).rowCount, 0);
    await pool.query("ALTER TABLE rail_risk_observations ENABLE TRIGGER rail_risk_immutable");
  });
});

test("behaviour status is participant-only, non-cacheable and throttled without exposing raw features", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = await transaction();
    await engine(model).execute(txn);
    assert.equal(await readBehaviourObservation(pool, txn.txId, "risk_other"), undefined);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_receiver")).status, "observed");
    const call = async (walletId, txId = txn.txId) => {
      const req = Readable.from([]);
      req.method = "GET";
      req.headers = {};
      req.socket = { remoteAddress: "192.0.2.50" };
      const headers = {};
      const res = { setHeader(key, value) { headers[key] = value; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      await handlePaymentRoutes(req, res, new URL(`http://localhost/v1/payments/${txId}/risk`), {
        pool, config: loadServerConfig(), authResolver: { async resolveAuthenticatedWallet() { return walletId; } }, rateLimiter: new PostgresRateLimiter(pool)
      });
      return { ...res, headers };
    };
    await assert.rejects(call("risk_other"), { status: 404 });
    await assert.rejects(call("risk_other", "missing_payment"), { status: 404 });
    const response = await call("risk_sender");
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.body.risk.synthetic, true);
    for (const field of ["feature_snapshot", "prediction", "model_hash", "senderWalletId"]) assert.ok(!JSON.stringify(response.body).includes(field));
    for (let i = 1; i < 30; i++) await call("risk_sender");
    await assert.rejects(call("risk_sender"), { status: 429 });
  });
});
