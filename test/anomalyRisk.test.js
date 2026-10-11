import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { trainAnomalyDataset, validateAnomalyModel, predictAnomaly, benchmarkAnomalyModel } from "../dist/risk/anomalyRisk.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { noopTracer } from "../dist/pipeline/tracing.js";

function rows(start, count = 20) {
  return Array.from({ length: count }, (_, index) => ({ eventId: `synthetic_anomaly_${start + index}`, amountMinor: 100,
    channel: "online", features: { schemaVersion: 1, observedAt: new Date(Date.UTC(2025, 0, 1 + start + index)).toISOString(),
      source: "postgres_posted_payments", historyWindowDays: 30, historyCount: 20, historyTruncated: false,
      recentCount: 1, receiverSeen: true, meanAmountMinor: 100, amountRatio: 1, amountZScore: 0,
      agentBudgetExposure: null, deviceChange: "not_assessed" } }));
}
function dataset() {
  return { featureSchema: "behaviour-anomaly-v1", modelVersion: "synthetic-anomaly-test", datasetId: "synthetic-reference-fixture",
    currency: "INR", synthetic: true, referenceSource: "synthetic", training: rows(0), calibration: rows(30), test: rows(60) };
}
function unusual(row) {
  return { ...row, amountMinor: 100000, features: { ...row.features, amountRatio: 1000, amountZScore: 10,
    recentCount: 20, receiverSeen: false } };
}

test("anomaly baseline learns a finite constant reference and explains unusual behaviour without probabilities", () => {
  const input = dataset(), { model, evaluation } = trainAnomalyDataset(input);
  assert.equal(model.centers.length, 9);
  assert.deepEqual(model.scales, Array(9).fill(0.05));
  assert.equal(model.threshold, 3);
  assert.equal(predictAnomaly(model, input.test[0]).distance, 0);
  const prediction = predictAnomaly(model, unusual(input.test[0]));
  assert.ok(prediction.unusual); assert.ok(prediction.distance > model.threshold);
  assert.ok(prediction.contributions.some(item => item.feature === "positive_amount_deviation" && item.distance > 0));
  assert.equal(prediction.contributions.length, 9);
  assert.equal(prediction.probability, undefined);
  assert.equal(evaluation.accuracy, "unavailable_without_independent_outcome_labels");
  assert.equal(evaluation.warning, "synthetic_anomaly_demo_not_fraud_validation");
});

test("anomaly reference fitting is deterministic, robust to a single outlier and independent of later cohorts", () => {
  const input = dataset(), original = trainAnomalyDataset(input);
  assert.deepEqual(trainAnomalyDataset(structuredClone(input)), original);
  input.training[19] = unusual(input.training[19]);
  const contaminated = trainAnomalyDataset(input);
  assert.deepEqual(contaminated.model.centers, original.model.centers);
  assert.deepEqual(contaminated.model.scales, original.model.scales);
  input.calibration = input.calibration.map(unusual);
  input.test = input.test.map(unusual);
  const changed = trainAnomalyDataset(input);
  assert.deepEqual(changed.model.centers, original.model.centers);
  assert.deepEqual(changed.model.scales, original.model.scales);
  assert.ok(changed.model.threshold > original.model.threshold);
  const before = structuredClone(changed.model);
  input.test = rows(60);
  const heldOut = trainAnomalyDataset(input);
  assert.equal(heldOut.model.threshold, before.threshold);
  assert.notEqual(heldOut.model.datasetHash, before.datasetHash);
  assert.equal(heldOut.evaluation.test.unusualRate, 0);
});

test("anomaly data rejects temporal overlap, duplicate events, false source declarations and unbounded input", () => {
  for (const change of [value => value.training.reverse(), value => value.calibration[0].eventId = value.training[0].eventId,
    value => value.training[19].features.observedAt = value.calibration[0].features.observedAt,
    value => value.calibration[19].features.observedAt = value.test[0].features.observedAt,
    value => value.test = [], value => value.training = rows(0, 10001), value => value.synthetic = false,
    value => value.referenceSource = "user_claim", value => value.currency = "inr",
    value => value.test[0].features.observedAt = "2025-02-30T00:00:00.000Z",
    value => value.training[0].features.recentCount = 999]) {
    const input = dataset(); change(input); assert.throws(() => trainAnomalyDataset(input));
  }
  const reviewed = dataset(); reviewed.synthetic = false; reviewed.referenceSource = "reviewed_reference";
  assert.equal(trainAnomalyDataset(reviewed).evaluation.warning, "reference_provenance_and_threshold_require_independent_review");
});

test("anomaly artifacts reject sparse, non-finite or incompatible vectors and isolate retained configuration", () => {
  const { model } = trainAnomalyDataset(dataset()), copy = validateAnomalyModel(model);
  model.centers[0] += 0.1; model.scales[0] += 0.1;
  assert.notDeepEqual(model.centers, copy.centers); assert.notDeepEqual(model.scales, copy.scales);
  for (const change of [{ centers: Array(9) }, { scales: Array(9) }, { scales: Array(9).fill(0) }, { centers: Array(9).fill(Infinity) },
    { threshold: NaN }, { threshold: 0 }, { threshold: 21 }, { trainingRows: 19 }, { calibrationRows: 10001 },
    { featureSchema: "behaviour-v1" }, { datasetHash: "invalid" }, { trainingCutoff: "invalid" }, { referenceSource: "reviewed_reference" }])
    assert.throws(() => validateAnomalyModel({ ...copy, ...change }), /INVALID_ANOMALY_MODEL_OR_DATA/);
  assert.throws(() => buildHardenedPaymentPipeline(noopTracer, undefined, undefined, undefined, undefined, copy),
    /ANOMALY_MODEL_REQUIRES_RISK_PROTECTION/);
});

test("anomaly inference rejects future training and incomplete history rather than inventing a score", () => {
  const input = dataset(), { model } = trainAnomalyDataset(input);
  assert.throws(() => predictAnomaly(model, input.training[0]), /ANOMALY_TEMPORAL_LEAKAGE/);
  assert.throws(() => predictAnomaly(model, { ...input.test[0], features: { ...input.test[0].features, observedAt: model.trainingCutoff } }), /ANOMALY_TEMPORAL_LEAKAGE/);
  const cold = { ...input.test[0], features: { ...input.test[0].features, historyCount: 0, recentCount: 0,
    receiverSeen: false, meanAmountMinor: null, amountRatio: null, amountZScore: null } };
  assert.throws(() => predictAnomaly(model, cold), /ANOMALY_HISTORY_UNAVAILABLE/);
  assert.throws(() => predictAnomaly(model, { ...input.test[0], features: { ...input.test[0].features,
    historyCount: 1000, historyTruncated: true } }), /ANOMALY_HISTORY_UNAVAILABLE/);
});

test("anomaly capped distances remain bounded and identify saturation on extreme valid inputs", () => {
  const input = dataset(), { model } = trainAnomalyDataset(input);
  const prediction = predictAnomaly(model, { ...unusual(input.test[0]), amountMinor: 1e12,
    features: { ...unusual(input.test[0]).features, amountRatio: 1e10, amountZScore: 1e10 } });
  assert.ok(prediction.distance >= 0 && prediction.distance <= 20);
  assert.ok(prediction.contributions.some(item => item.clipped));
  assert.ok(prediction.contributions.every(item => Number.isFinite(item.distance)));
});

test("anomaly CLI creates private reloadable artifacts without individual data and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rail-anomaly-"));
  try {
    const input = join(directory, "dataset.json"), output = join(directory, "model.json");
    await writeFile(input, JSON.stringify(dataset()));
    const report = JSON.parse(execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { encoding: "utf8" }));
    assert.equal(report.featureSchema, "behaviour-anomaly-v1");
    assert.equal(report.evaluation.test.rows, 20);
    for (const row of [...dataset().training, ...dataset().calibration, ...dataset().test]) assert.ok(!JSON.stringify(report).includes(row.eventId));
    assert.equal(report.benchmark.scope, "local_anomaly_inference_only");
    const before = await readFile(output, "utf8");
    assert.equal(validateAnomalyModel(JSON.parse(before)).synthetic, true);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { stdio: "pipe" }));
    assert.equal(await readFile(output, "utf8"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("anomaly inference benchmarks are bounded and separate from deterministic fitting and held-out reports", () => {
  const input = dataset(), { model } = trainAnomalyDataset(input);
  const report = benchmarkAnomalyModel(model, input.test, 20);
  assert.equal(report.iterations, 20);
  assert.ok(report.p95Ms >= report.p50Ms);
  assert.ok(Number.isFinite(report.maxMs));
  assert.throws(() => benchmarkAnomalyModel(model, [], 10));
  assert.throws(() => benchmarkAnomalyModel(model, input.test, 10001));
});
