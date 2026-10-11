import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BEHAVIOUR_FEATURE_NAMES, behaviourFeatureVector, validateBehaviourModel, predictBehaviourRisk,
  trainBehaviourDataset, evaluateBehaviourModel, benchmarkBehaviourModel } from "../dist/risk/behaviourModel.js";
import { fitLogisticWeights, readRiskJson, validateRiskModel } from "../dist/risk/logisticRisk.js";

function examples(start, count) {
  return Array.from({ length: count }, (_, index) => {
    const label = index % 2;
    const observedAt = new Date(Date.UTC(2026, 0, 1 + start + index)).toISOString();
    return { eventId: `synthetic_${start + index}`, amountMinor: 100, channel: "online", label,
      labelSource: "synthetic", labelObservedAt: new Date(Date.parse(observedAt) + 3600000).toISOString(),
      features: { schemaVersion: 1, observedAt, source: "postgres_posted_payments", historyWindowDays: 30,
        historyCount: 20, historyTruncated: false, recentCount: label ? 15 : 0, receiverSeen: label === 0,
        meanAmountMinor: 100, amountRatio: 1, amountZScore: 0, agentBudgetExposure: label ? 0.9 : 0.1, deviceChange: "not_assessed" } };
  });
}

function dataset() {
  return { featureSchema: "behaviour-v1", modelVersion: "synthetic-behaviour-test", datasetId: "synthetic-temporal-fixture",
    currency: "INR", synthetic: true, training: examples(0, 20), validation: examples(30, 4), test: examples(40, 4) };
}

test("behaviour ML learns risk differences from trusted history even when amount and channel are identical", () => {
  const input = dataset();
  const { model, evaluation } = trainBehaviourDataset(input);
  const low = predictBehaviourRisk(model, input.test[0]), high = predictBehaviourRisk(model, input.test[1]);
  assert.ok(low.probability < 0.5);
  assert.ok(high.probability > 0.5);
  assert.equal(model.weights.length, 10);
  assert.deepEqual(high.contributions.map(item => item.feature), [...BEHAVIOUR_FEATURE_NAMES]);
  assert.ok(evaluation.test.brierScore < 0.25);
  assert.ok(evaluation.test.logLoss < Math.log(2));
  assert.equal(evaluation.test.averagePrecision, 1);
  assert.equal(evaluation.test.falsePositiveRate, 0);
  assert.equal(evaluation.test.calibration.length, 10);
  assert.equal(evaluation.warning, "synthetic_demonstration_not_fraud_validation");
  assert.match(model.datasetHash, /^[a-f0-9]{64}$/);
});

test("behaviour training is deterministic and does not fit validation or test labels", () => {
  const input = dataset();
  const original = trainBehaviourDataset(input);
  assert.deepEqual(trainBehaviourDataset(structuredClone(input)), original);
  for (const row of input.validation) row.label = 1 - row.label;
  for (const row of input.test) row.label = 1 - row.label;
  const changed = trainBehaviourDataset(input);
  assert.deepEqual(changed.model.weights, original.model.weights);
  assert.notEqual(changed.model.datasetHash, original.model.datasetHash);
  assert.equal(changed.evaluation.test.recall, 0);
});

test("behaviour dataset rejects overlapping observation periods, late labels, duplicate events and invalid provenance", () => {
  const changes = [
    value => { value.training[19].labelObservedAt = value.validation[0].features.observedAt; },
    value => { value.validation[3].labelObservedAt = value.test[0].features.observedAt; },
    value => { value.validation[0].eventId = value.training[0].eventId; },
    value => { value.training.reverse(); },
    value => { value.training[0].labelObservedAt = "2025-01-01T00:00:00.000Z"; },
    value => { value.synthetic = false; },
    value => { value.test = []; },
    value => { value.featureSchema = "unknown"; },
    value => { value.training[0].labelSource = "user_claim"; },
    value => { value.training[0].features.observedAt = "2026-02-30T00:00:00.000Z"; },
  ];
  for (const change of changes) { const value = dataset(); change(value); assert.throws(() => trainBehaviourDataset(value)); }
});

test("behaviour features reject forged counts, ratios, identities, time and non-finite input", () => {
  const row = dataset().test[0];
  const vector = behaviourFeatureVector(row);
  assert.equal(vector.length, 10);
  assert.ok(vector.every(Number.isFinite));
  for (const change of [{ historyCount: 1001 }, { recentCount: 21 }, { source: "client" }, { deviceChange: "verified" },
    { amountRatio: 999 }, { meanAmountMinor: NaN }, { amountZScore: Infinity }, { historyTruncated: true },
    { agentBudgetExposure: 1.1 }, { observedAt: "invalid" }, { historyCount: 0 }]) {
    assert.throws(() => behaviourFeatureVector({ ...row, features: { ...row.features, ...change } }));
  }
  assert.throws(() => behaviourFeatureVector({ ...row, amountMinor: 0 }));
});

test("behaviour features encode cold start, missing budget and truncation explicitly", () => {
  const row = dataset().test[0];
  const cold = { ...row.features, historyCount: 0, recentCount: 0, receiverSeen: false, meanAmountMinor: null,
    amountRatio: null, amountZScore: null, agentBudgetExposure: null };
  const vector = behaviourFeatureVector({ ...row, features: cold });
  assert.equal(vector[8], 1);
  assert.equal(vector[9], 1);
  assert.equal(behaviourFeatureVector({ ...row, features: { ...row.features, historyCount: 1000, historyTruncated: true } })[8], 1);
});

test("behaviour artifacts reject corrupt metadata or weights and isolate caller mutation", () => {
  const { model } = trainBehaviourDataset(dataset());
  const copy = validateBehaviourModel(model);
  const before = [...copy.weights];
  model.weights[0] += 5;
  assert.deepEqual(copy.weights, before);
  for (const change of [{ schemaVersion: 2 }, { featureSchema: "unknown" }, { datasetHash: "wrong" }, { trainingRows: 10001 },
    { trainingCutoff: "not-a-time" }, { synthetic: undefined }, { weights: [0] }, { weights: Array(10) }, { weights: Array(10).fill(Infinity) }]) {
    assert.throws(() => validateBehaviourModel({ ...copy, ...change }));
  }
});

test("shared logistic training and both artifact schemas reject sparse vectors and oversized work", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ input: [1, index / 10], label: index % 2 }));
  assert.throws(() => fitLogisticWeights(rows.map(row => ({ ...row, input: Array(2) })), 2));
  assert.throws(() => fitLogisticWeights(Array.from({ length: 10001 }, (_, index) => rows[index % 10]), 2));
  assert.throws(() => validateRiskModel({ schemaVersion: 1, modelVersion: "test", datasetId: "test", currency: "INR", synthetic: true,
    trainingRows: 10, weights: Array(3) }));
});

test("behaviour inference refuses observations at or before the model training cutoff", () => {
  const input = dataset(), { model } = trainBehaviourDataset(input);
  assert.throws(() => predictBehaviourRisk(model, input.training[0]), /BEHAVIOUR_MODEL_TEMPORAL_LEAKAGE/);
  assert.throws(() => predictBehaviourRisk(model, { ...input.test[0], features: { ...input.test[0].features, observedAt: model.trainingCutoff } }),
    /BEHAVIOUR_MODEL_TEMPORAL_LEAKAGE/);
});

test("behaviour calibration and tied-score precision-recall reporting do not depend on label order", () => {
  const input = dataset(), { model } = trainBehaviourDataset(input);
  const constant = { ...model, weights: Array(10).fill(0) };
  const report = evaluateBehaviourModel(constant, input.test);
  assert.equal(report.brierScore, 0.25);
  assert.equal(report.expectedCalibrationError, 0);
  assert.equal(report.averagePrecision, 0.5);
  assert.equal(report.precision, 0.5);
  const swapped = structuredClone(input.test);
  for (const row of swapped) row.label = 1 - row.label;
  assert.deepEqual(evaluateBehaviourModel(constant, swapped), report);
});

test("behaviour CLI writes protected reloadable artifacts and refuses overwrite or unsupported schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rail-behaviour-model-"));
  try {
    const input = join(directory, "dataset.json"), output = join(directory, "model.json");
    await writeFile(input, JSON.stringify(dataset()));
    const report = JSON.parse(execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { encoding: "utf8" }));
    const before = await readFile(output, "utf8");
    assert.equal(report.featureSchema, "behaviour-v1");
    assert.equal(report.evaluation.test.rows, 4);
    assert.equal(report.benchmark.scope, "local_inference_only");
    assert.ok(report.benchmark.p95Ms >= report.benchmark.p50Ms);
    assert.ok(Number.isFinite(report.benchmark.maxMs));
    assert.equal(validateBehaviourModel(JSON.parse(before)).synthetic, true);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { stdio: "pipe" }));
    assert.equal(await readFile(output, "utf8"), before);
    await writeFile(input, JSON.stringify({ ...dataset(), featureSchema: "unknown" }));
    assert.throws(() => execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, join(directory, "invalid.json")], { stdio: "pipe" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("behaviour inference benchmarks are bounded and separated from deterministic evaluation", () => {
  const input = dataset(), { model } = trainBehaviourDataset(input);
  const result = benchmarkBehaviourModel(model, input.test, 20);
  assert.equal(result.iterations, 20);
  assert.ok(result.p95Ms >= result.p50Ms);
  assert.throws(() => benchmarkBehaviourModel(model, input.test, 10001));
  assert.throws(() => benchmarkBehaviourModel(model, [], 10));
});

test("risk artifact reads have a hard size bound and reject directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rail-risk-read-"));
  try {
    const path = join(directory, "data.json");
    await writeFile(path, JSON.stringify({ value: "x".repeat(100) }));
    await assert.rejects(readRiskJson(path, 10), /RISK_JSON_SIZE_LIMIT/);
    await assert.rejects(readRiskJson(directory), /RISK_JSON_SIZE_LIMIT/);
    assert.equal((await readRiskJson(path)).value.length, 100);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
