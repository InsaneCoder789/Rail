import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
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
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { RiskProtectionStore, decryptRiskRecord } from "../dist/persistence/riskProtection.js";
import { trainAnomalyDataset } from "../dist/risk/anomalyRisk.js";

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
    const engine = (riskModel, after, behaviourModel, protection, required = false, anomalyModel) => {
      const pipeline = buildHardenedPaymentPipeline(noopTracer, undefined, riskModel, behaviourModel, protection, anomalyModel);
      return new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
        riskProtectionRequired: required,
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

function riskKeys(keyId = "risk_test_v1") { return { keyId, encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) }; }

function anomalyArtifact() {
  const rows = start => Array.from({ length: 20 }, (_, index) => ({ eventId: `reference_${start + index}`, amountMinor: 100,
    channel: "online", features: { schemaVersion: 1, observedAt: new Date(Date.UTC(2025, 0, 1 + start + index)).toISOString(),
      source: "postgres_posted_payments", historyWindowDays: 30, historyCount: 20, historyTruncated: false,
      recentCount: 1, receiverSeen: true, meanAmountMinor: 100, amountRatio: 1, amountZScore: 0,
      agentBudgetExposure: null, deviceChange: "not_assessed" } }));
  return trainAnomalyDataset({ featureSchema: "behaviour-anomaly-v1", modelVersion: "synthetic-runtime-anomaly",
    datasetId: "synthetic-reference", currency: "INR", synthetic: true, referenceSource: "synthetic",
    training: rows(0), calibration: rows(30), test: rows(60) }).model;
}

test("protected records written before anomaly support verify unchanged after the additive schema migration", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    const legacyWriter = { async persist(client, binding, record) {
      const { anomaly, ...beforeAnomaly } = record;
      await protection.persist(client, binding, beforeAnomaly);
    } };
    const txn = await transaction(); await engine(model, undefined, undefined, legacyWriter, true).execute(txn);
    const before = (await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0];
    // Recreate the prior schema shape inside this isolated fixture before the additive upgrade.
    await pool.query("ALTER TABLE rail_risk_observations DROP CONSTRAINT rail_risk_anomaly_summary_check");
    await pool.query("ALTER TABLE rail_risk_observations DROP COLUMN anomaly_summary");
    await runMigrations(pool);
    const response = await readBehaviourObservation(pool, txn.txId, "risk_sender", protection);
    assert.equal(response.protection, "verified");
    assert.deepEqual(response.anomaly, { status: "not_configured" });
    assert.deepEqual((await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0], before);
  });
});

test("anomaly runtime uses trusted history alongside ML and keeps detailed distances encrypted across replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key])), artifact = anomalyArtifact();
    const runtime = engine(model, undefined, undefined, protection, true, artifact);
    artifact.centers[0] = 2;
    const first = await transaction(); await runtime.execute(first);
    const cold = (await readBehaviourObservation(pool, first.txId, "risk_sender", protection)).anomaly;
    assert.deepEqual(cold, { status: "insufficient_history" });
    for (let i = 0; i < 5; i++) await runtime.execute(await transaction());
    const txn = await transaction(100000, "risk_other");
    const receipt = await runtime.execute({ ...txn, anomalyScore: 0, features: { historyCount: 0 } });
    assert.equal(receipt.status, "accepted");
    const row = (await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0];
    const decoded = decryptRiskRecord(row.envelope, { txId: txn.txId, requestFingerprint: row.request_fingerprint }, key);
    assert.equal(decoded.anomaly.summary.status, "available");
    assert.equal(decoded.anomaly.prediction.unusual, true);
    assert.ok(Number.isFinite(decoded.prediction.probability));
    assert.match(decoded.anomaly.modelHash, /^[a-f0-9]{64}$/);
    const summary = await readBehaviourObservation(pool, txn.txId, "risk_sender", protection);
    assert.deepEqual(summary.anomaly, { status: "available", modelVersion: "synthetic-runtime-anomaly", synthetic: true });
    assert.ok(!JSON.stringify(summary).includes("distance"));
    await engine(model, undefined, undefined, protection, true, { ...anomalyArtifact(), modelVersion: "replacement" }).execute(txn);
    assert.deepEqual((await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0], row);
    await runMigrations(pool);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_sender", protection)).protection, "verified");
  });
});

test("anomaly runtime explicitly records unavailable models without a fallback or transfer denial", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    for (const [change, expected] of [[{ currency: "USD" }, "currency_mismatch"], [{ trainingCutoff: "2099-01-01T00:00:00.000Z" }, "not_yet_valid"]]) {
      const txn = await transaction();
      assert.equal((await engine(model, undefined, undefined, protection, true, { ...anomalyArtifact(), ...change }).execute(txn)).status, "accepted");
      assert.deepEqual((await readBehaviourObservation(pool, txn.txId, "risk_sender", protection)).anomaly, { status: expected });
      const row = (await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0];
      const record = decryptRiskRecord(row.envelope, { txId: txn.txId, requestFingerprint: row.request_fingerprint }, key);
      assert.equal(record.anomaly.prediction, null);
    }
  });
});

test("anomaly summary tampering fails authenticated reads and failed observations roll back money", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    const runtime = engine(undefined, undefined, undefined, protection, true, anomalyArtifact());
    const txn = await transaction(); await runtime.execute(txn);
    await pool.query("ALTER TABLE rail_risk_observations DISABLE TRIGGER rail_risk_immutable");
    await assert.rejects(pool.query("UPDATE rail_risk_observations SET anomaly_summary = '{\"status\":\"insufficient_history\",\"distance\":99}' WHERE tx_id = $1", [txn.txId]),
      /rail_risk_anomaly_summary_check/);
    await pool.query("UPDATE rail_risk_observations SET anomaly_summary = '{\"status\":\"not_configured\"}' WHERE tx_id = $1", [txn.txId]);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_sender", protection)).reason, "verification_failed");
    await pool.query("ALTER TABLE rail_risk_observations ENABLE TRIGGER rail_risk_immutable");
    await pool.query(`CREATE FUNCTION fail_anomaly_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'anomaly_observation_failure'; END $$;
      CREATE TRIGGER fail_anomaly_observation BEFORE INSERT ON rail_risk_observations FOR EACH ROW EXECUTE FUNCTION fail_anomaly_observation()`);
    const next = await transaction();
    await assert.rejects(runtime.execute(next), /anomaly_observation_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [next.txId])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM ledger_entries WHERE tx_id = $1", [next.txId])).rowCount, 0);
    await pool.query("DROP TRIGGER fail_anomaly_observation ON rail_risk_observations");
    assert.equal((await runtime.execute(next)).status, "accepted");
  });
});

test("protected risk commits ciphertext without raw features, model hashes or probabilities in relational/event copies", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    const runtime = engine(model, undefined, undefined, protection, true), txn = await transaction();
    const result = await runtime.execute(txn);
    await Promise.all(Array.from({ length: 5 }, () => runtime.execute(txn)));
    const row = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [txn.txId])).rows[0];
    assert.equal(row.protection_required, true);
    assert.equal(row.feature_snapshot, null); assert.equal(row.model_hash, null); assert.equal(row.prediction, null);
    const protectedRow = (await pool.query("SELECT * FROM rail_protected_risk WHERE tx_id = $1", [txn.txId])).rows[0];
    const decoded = decryptRiskRecord(protectedRow.envelope, { txId: txn.txId, requestFingerprint: row.request_fingerprint }, key);
    assert.equal(decoded.features.historyCount, 0);
    assert.ok(Number.isFinite(decoded.prediction.probability));
    assert.match(decoded.modelHash, /^[a-f0-9]{64}$/);
    assert.equal((await pool.query("SELECT * FROM rail_protected_risk")).rowCount, 1);
    assert.equal((await pool.query("SELECT * FROM rail_risk_key_usage")).rows[0].record_count, "1");
    assert.equal((await pool.query("SELECT * FROM outbox WHERE type = 'risk.shadow_assessed'")).rowCount, 0);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_sender", protection)).protection, "verified");
    assert.equal(await readBehaviourObservation(pool, txn.txId, "risk_other", protection), undefined);
    assert.deepEqual(await runtime.execute(txn), result);
    await assert.rejects(pool.query("DELETE FROM rail_protected_risk WHERE tx_id = $1", [txn.txId]), /posted_payment_history_is_immutable/);
    await runMigrations(pool);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_receiver", protection)).protection, "verified");
  });
});

test("protected risk key rotation preserves verification and missing keys never return unverified summaries", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const old = riskKeys(), next = riskKeys("risk_test_v2");
    const first = new RiskProtectionStore(new TransactionKeyRing(old.keyId, [old]));
    const txn = await transaction(); await engine(model, undefined, undefined, first).execute(txn);
    const retained = new RiskProtectionStore(new TransactionKeyRing(next.keyId, [old, next]));
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_sender", retained)).protection, "verified");
    const lost = new RiskProtectionStore(new TransactionKeyRing(next.keyId, [next]));
    assert.deepEqual(await readBehaviourObservation(pool, txn.txId, "risk_sender", lost),
      { txId: txn.txId, status: "verification_unavailable", reason: "key_unavailable" });
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_sender")).status, "verification_unavailable");
    await engine(model, undefined, undefined, retained).execute(await transaction());
    assert.equal((await pool.query("SELECT * FROM rail_risk_key_usage")).rowCount, 2);
  });
});

test("protected risk quota and failed writes roll back money, quota and replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key], 1));
    const txn = await transaction();
    await pool.query(`CREATE FUNCTION fail_protected_risk() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_risk_cipher_failure'; END $$;
      CREATE TRIGGER fail_protected_risk BEFORE INSERT ON rail_protected_risk FOR EACH ROW EXECUTE FUNCTION fail_protected_risk()`);
    await assert.rejects(engine(model, undefined, undefined, protection).execute(txn), /injected_risk_cipher_failure/);
    for (const table of ["rail_protected_risk", "rail_risk_key_usage", "ledger_entries", "rail_idempotency", "rail_risk_observations"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
    await pool.query("DROP TRIGGER fail_protected_risk ON rail_protected_risk");
    await engine(model, undefined, undefined, protection).execute(txn);
    await assert.rejects(engine(model, undefined, undefined, protection).execute(await transaction()), /risk_key_rotation_required/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await pool.query("SELECT * FROM rail_risk_key_usage")).rows[0].record_count, "1");
  });
});

test("protected risk requirement and deferred missing-envelope checks cannot commit an unprotected payment", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const txn = await transaction();
    await assert.rejects(engine(model, undefined, undefined, undefined, true).execute(txn), /risk_protection_required/);
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    await pool.query("ALTER TABLE rail_protected_risk DISABLE TRIGGER rail_protected_risk_immutable");
    await assert.rejects(engine(model, async ctx => {
      assert.equal(ctx.result.status, "accepted");
      await ctx.dbClient.query("DELETE FROM rail_protected_risk WHERE tx_id = $1", [txn.txId]);
    }, undefined, protection, true).execute(txn), /payment_risk_protection_missing/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_risk_key_usage")).rowCount, 0);
    await pool.query("ALTER TABLE rail_protected_risk ENABLE TRIGGER rail_protected_risk_immutable");
  });
});

test("protected risk detects tampered summaries instead of exposing an authenticated-looking reason", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    const txn = await transaction(); await engine(model, undefined, undefined, protection).execute(txn);
    await pool.query("ALTER TABLE rail_risk_observations DISABLE TRIGGER rail_risk_immutable");
    await pool.query(`UPDATE rail_risk_observations SET assessment = jsonb_set(assessment,'{reasons}','["forged"]') WHERE tx_id = $1`, [txn.txId]);
    assert.deepEqual(await readBehaviourObservation(pool, txn.txId, "risk_sender", protection),
      { txId: txn.txId, status: "verification_unavailable", reason: "verification_failed" });
    await pool.query("ALTER TABLE rail_risk_observations ENABLE TRIGGER rail_risk_immutable");
  });
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

const behaviourModel = { schemaVersion: 1, featureSchema: "behaviour-v1", modelVersion: "synthetic-behaviour-integration",
  datasetId: "synthetic-integration", datasetHash: "a".repeat(64), currency: "INR", synthetic: true, trainingRows: 20,
  trainingCutoff: "2025-01-01T00:00:00.000Z", weights: [-2, 0, 0, 5, 0, 0, 2, 0, 0, 0] };

test("behaviour ML consumes locked database history, takes precedence and preserves its original prediction on replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    const mutable = { ...behaviourModel, weights: [...behaviourModel.weights] };
    const runtime = engine(model, undefined, mutable);
    mutable.weights[0] = 100;
    const first = await transaction();
    await runtime.execute({ ...first, features: { recentCount: 999, receiverSeen: true } });
    const original = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [first.txId])).rows[0];
    assert.equal(original.model_version, behaviourModel.modelVersion);
    assert.equal(original.prediction.modelKind, "behaviour-v1");
    assert.equal(original.prediction.contributions.find(item => item.feature === "recent_velocity").value, 0);
    assert.equal(original.prediction.contributions.find(item => item.feature === "intercept").value, -2);
    for (let i = 0; i < 5; i++) await runtime.execute(await transaction());
    const next = await transaction(100, "risk_other");
    assert.equal((await runtime.execute(next)).status, "accepted");
    const observed = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [next.txId])).rows[0];
    assert.equal(observed.feature_snapshot.recentCount, 6);
    assert.ok(observed.prediction.probability > original.prediction.probability);
    await engine(undefined, undefined, { ...behaviourModel, modelVersion: "rolled_back", weights: Array(10).fill(0) }).execute(first);
    assert.deepEqual((await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [first.txId])).rows[0], original);
    assert.equal((await pool.query("SELECT * FROM outbox WHERE type = 'risk.shadow_assessed'")).rowCount, 0);
  });
});

test("behaviour ML reports future cutoff or currency mismatch without falling back or blocking valid payments", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, engine, transaction }) => {
    for (const [change, expected] of [[{ trainingCutoff: "2099-01-01T00:00:00.000Z" }, "not_yet_valid"], [{ currency: "USD" }, "currency_mismatch"]]) {
      const txn = await transaction();
      assert.equal((await engine(model, undefined, { ...behaviourModel, ...change }).execute(txn)).status, "accepted");
      const observation = (await pool.query("SELECT * FROM rail_risk_observations WHERE tx_id = $1", [txn.txId])).rows[0];
      assert.equal(observation.model_status, expected);
      assert.equal(observation.prediction, null);
      assert.equal(observation.model_version, null);
    }
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
    const key = riskKeys(), protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    await engine(model, undefined, undefined, protection, true).execute(txn);
    assert.equal(await readBehaviourObservation(pool, txn.txId, "risk_other"), undefined);
    assert.equal((await readBehaviourObservation(pool, txn.txId, "risk_receiver", protection)).status, "observed");
    let source = 0;
    const call = async (walletId, txId = txn.txId) => {
      const req = Readable.from([]);
      req.method = "GET";
      req.headers = {};
      req.socket = { remoteAddress: `192.0.2.${++source}` };
      const headers = {};
      const res = { setHeader(key, value) { headers[key] = value; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      await handlePaymentRoutes(req, res, new URL(`http://localhost/v1/payments/${txId}/risk`), {
        pool, riskProtection: protection, config: loadServerConfig(), authResolver: { async resolveAuthenticatedWallet() { return walletId; } }, rateLimiter: new PostgresRateLimiter(pool)
      });
      return { ...res, headers };
    };
    await assert.rejects(call("risk_other"), { status: 404 });
    await assert.rejects(call("risk_other", "missing_payment"), { status: 404 });
    const response = await call("risk_sender");
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.body.risk.synthetic, true);
    assert.equal(response.body.risk.protection, "verified");
    for (const field of ["feature_snapshot", "prediction", "model_hash", "senderWalletId"]) assert.ok(!JSON.stringify(response.body).includes(field));
    for (let i = 1; i < 30; i++) await call("risk_sender");
    await assert.rejects(call("risk_sender"), { status: 429 });
  });
});
