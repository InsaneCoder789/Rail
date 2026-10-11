import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BehaviourFeatures } from "./behaviourRisk.js";
import type { PaymentTransaction } from "../domain/types.js";
import { fitLogisticWeights, sigmoid } from "./logisticRisk.js";

export const BEHAVIOUR_FEATURE_NAMES = Object.freeze(["intercept", "log_amount", "offline_channel", "recent_velocity",
  "amount_ratio", "positive_amount_deviation", "receiver_unseen", "agent_budget_exposure", "history_incomplete", "budget_unavailable"]);

export interface BehaviourRiskModel {
  readonly schemaVersion: 1;
  readonly featureSchema: "behaviour-v1";
  readonly modelVersion: string;
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly trainingRows: number;
  readonly trainingCutoff: string;
  readonly weights: readonly number[];
}

export interface BehaviourInput {
  readonly amountMinor: number;
  readonly channel: PaymentTransaction["channel"];
  readonly features: BehaviourFeatures;
}

export interface BehaviourExample extends BehaviourInput {
  readonly eventId: string;
  readonly label: 0 | 1;
  readonly labelObservedAt: string;
  readonly labelSource: "synthetic" | "confirmed_outcome";
}

interface BehaviourDataset {
  readonly featureSchema: "behaviour-v1";
  readonly modelVersion: string;
  readonly datasetId: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly training: readonly BehaviourExample[];
  readonly validation: readonly BehaviourExample[];
  readonly test: readonly BehaviourExample[];
}

function fail(): never { throw new Error("INVALID_BEHAVIOUR_MODEL_OR_DATA"); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 128; }
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return Date.parse(value);
}

export function behaviourFeatureVector(input: BehaviourInput): readonly number[] {
  if (!input || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 1e12 ||
      !["online", "nfc", "ble", "qr"].includes(input.channel)) fail();
  const f = input.features;
  if (!f || f.schemaVersion !== 1 || f.source !== "postgres_posted_payments" || f.historyWindowDays !== 30 ||
      f.deviceChange !== "not_assessed" || !Number.isSafeInteger(f.historyCount) || f.historyCount < 0 || f.historyCount > 1000 ||
      !Number.isSafeInteger(f.recentCount) || f.recentCount < 0 || f.recentCount > f.historyCount ||
      typeof f.historyTruncated !== "boolean" || typeof f.receiverSeen !== "boolean" ||
      (f.historyTruncated && f.historyCount !== 1000) ||
      (f.agentBudgetExposure !== null && (!Number.isFinite(f.agentBudgetExposure) || f.agentBudgetExposure < 0 || f.agentBudgetExposure > 1)) ||
      (f.amountZScore !== null && (!Number.isFinite(f.amountZScore) || f.historyCount < 5))) fail();
  timestamp(f.observedAt);
  if (f.historyCount === 0) {
    if (f.meanAmountMinor !== null || f.amountRatio !== null || f.amountZScore !== null || f.receiverSeen) fail();
  } else {
    if (typeof f.meanAmountMinor !== "number" || !Number.isFinite(f.meanAmountMinor) || f.meanAmountMinor < 1 ||
        f.meanAmountMinor > Number.MAX_SAFE_INTEGER || typeof f.amountRatio !== "number" || !Number.isFinite(f.amountRatio) ||
        f.amountRatio <= 0 || Math.abs(f.amountRatio - input.amountMinor / f.meanAmountMinor) > 1e-9 * Math.max(1, f.amountRatio)) fail();
  }
  return [1, Math.log1p(input.amountMinor) / Math.log1p(1e6), input.channel === "online" ? 0 : 1,
    Math.log1p(f.recentCount) / Math.log1p(1000), Math.log1p(Math.min(f.amountRatio ?? 0, 1000)) / Math.log1p(1000),
    Math.min(Math.max(f.amountZScore ?? 0, 0), 10) / 10, f.receiverSeen ? 0 : 1, f.agentBudgetExposure ?? 0,
    f.historyCount < 5 || f.historyTruncated ? 1 : 0, f.agentBudgetExposure === null ? 1 : 0];
}

export function validateBehaviourModel(value: unknown): BehaviourRiskModel {
  if (!value || typeof value !== "object") fail();
  const model = value as BehaviourRiskModel;
  if (model.schemaVersion !== 1 || model.featureSchema !== "behaviour-v1" || !text(model.modelVersion) || !text(model.datasetId) ||
      typeof model.datasetHash !== "string" || !/^[a-f0-9]{64}$/.test(model.datasetHash) || typeof model.synthetic !== "boolean" ||
      typeof model.currency !== "string" || !/^[A-Z]{3}$/.test(model.currency) || !Number.isSafeInteger(model.trainingRows) ||
      model.trainingRows < 10 || model.trainingRows > 10000 || !Array.isArray(model.weights) ||
      model.weights.length !== BEHAVIOUR_FEATURE_NAMES.length || Array.from(model.weights).some(weight => typeof weight !== "number" ||
        !Number.isFinite(weight) || Math.abs(weight) > 1e6)) fail();
  timestamp(model.trainingCutoff);
  return { schemaVersion: 1, featureSchema: "behaviour-v1", modelVersion: model.modelVersion, datasetId: model.datasetId,
    datasetHash: model.datasetHash, currency: model.currency, synthetic: model.synthetic, trainingRows: model.trainingRows,
    trainingCutoff: model.trainingCutoff, weights: [...model.weights] };
}

export function predictBehaviourRisk(model: BehaviourRiskModel, input: BehaviourInput) {
  const artifact = validateBehaviourModel(model);
  const vector = behaviourFeatureVector(input);
  if (timestamp(input.features.observedAt) <= timestamp(artifact.trainingCutoff)) throw new Error("BEHAVIOUR_MODEL_TEMPORAL_LEAKAGE");
  const contributions = vector.map((value, index) => ({ feature: BEHAVIOUR_FEATURE_NAMES[index], value: value * artifact.weights[index] }));
  return { probability: sigmoid(contributions.reduce((sum, item) => sum + item.value, 0)), contributions };
}

function validateSplit(rows: readonly BehaviourExample[], minimum: number, synthetic: boolean, ids: Set<string>) {
  if (!Array.isArray(rows) || rows.length < minimum || rows.length > 10000) fail();
  let prior = -Infinity, lastLabel = -Infinity;
  for (const row of rows) {
    if (!row || !text(row.eventId) || ids.has(row.eventId) || (row.label !== 0 && row.label !== 1) ||
        row.labelSource !== (synthetic ? "synthetic" : "confirmed_outcome")) fail();
    ids.add(row.eventId);
    behaviourFeatureVector(row);
    const observed = timestamp(row.features.observedAt), labelled = timestamp(row.labelObservedAt);
    if (observed < prior || labelled < observed) fail();
    prior = observed;
    lastLabel = Math.max(lastLabel, labelled);
  }
  if (!rows.some(row => row.label === 0) || !rows.some(row => row.label === 1)) fail();
  return { firstObservation: timestamp(rows[0].features.observedAt), lastLabel };
}

export function evaluateBehaviourModel(model: BehaviourRiskModel, rows: readonly BehaviourExample[]) {
  validateSplit(rows, 2, model.synthetic, new Set());
  const scored = rows.map(row => ({ label: row.label, probability: predictBehaviourRisk(model, row).probability }));
  let logLoss = 0, brier = 0, tp = 0, fp = 0, fn = 0, tn = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probabilitySum: 0, positives: 0 }));
  for (const row of scored) {
    const p = Math.max(1e-12, Math.min(1 - 1e-12, row.probability));
    logLoss -= row.label * Math.log(p) + (1 - row.label) * Math.log(1 - p);
    brier += (row.probability - row.label) ** 2;
    if (row.probability >= 0.5) { if (row.label === 1) tp++; else fp++; }
    else if (row.label === 1) fn++; else tn++;
    const bin = bins[Math.min(9, Math.floor(row.probability * 10))];
    bin.count++; bin.probabilitySum += row.probability; bin.positives += row.label;
  }
  scored.sort((a,b) => b.probability - a.probability);
  let seen = 0, positives = 0, averagePrecision = 0;
  // Score ties enter together: input order must not inflate precision-recall results.
  for (let i = 0; i < scored.length;) {
    let end = i, groupPositives = 0;
    while (end < scored.length && scored[end].probability === scored[i].probability) groupPositives += scored[end++].label;
    seen += end - i; positives += groupPositives;
    averagePrecision += groupPositives / (tp + fn) * positives / seen;
    i = end;
  }
  const calibration = bins.map((bin, index) => ({ lower: index / 10, upper: (index + 1) / 10, rows: bin.count,
    meanProbability: bin.count ? bin.probabilitySum / bin.count : null, observedRate: bin.count ? bin.positives / bin.count : null }));
  return { rows: rows.length, threshold: 0.5, logLoss: logLoss / rows.length, brierScore: brier / rows.length,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp / (tp + fn), falsePositiveRate: fp / (fp + tn),
    averagePrecision, calibration, expectedCalibrationError: bins.reduce((sum, bin) => sum + (bin.count ?
      Math.abs(bin.probabilitySum / bin.count - bin.positives / bin.count) * bin.count / rows.length : 0), 0),
    confusion: { truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn } };
}

export function benchmarkBehaviourModel(model: BehaviourRiskModel, rows: readonly BehaviourExample[], iterations = 1000) {
  if (!Array.isArray(rows) || !rows.length || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10000) fail();
  for (let i = 0; i < Math.min(100, iterations); i++) predictBehaviourRisk(model, rows[i % rows.length]);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    predictBehaviourRisk(model, rows[i % rows.length]);
    timings.push(performance.now() - start);
  }
  timings.sort((a,b) => a-b);
  return { scope: "local_inference_only", iterations, p50Ms: timings[Math.ceil(iterations * 0.5) - 1],
    p95Ms: timings[Math.ceil(iterations * 0.95) - 1], maxMs: timings[timings.length - 1] };
}

export function trainBehaviourDataset(value: unknown) {
  if (!value || typeof value !== "object") fail();
  const dataset = value as BehaviourDataset;
  if (dataset.featureSchema !== "behaviour-v1" || !text(dataset.modelVersion) || !text(dataset.datasetId) ||
      typeof dataset.currency !== "string" || !/^[A-Z]{3}$/.test(dataset.currency) || typeof dataset.synthetic !== "boolean") fail();
  const ids = new Set<string>();
  const training = validateSplit(dataset.training, 10, dataset.synthetic, ids);
  const validation = validateSplit(dataset.validation, 2, dataset.synthetic, ids);
  const test = validateSplit(dataset.test, 2, dataset.synthetic, ids);
  if (training.lastLabel >= validation.firstObservation || validation.lastLabel >= test.firstObservation) {
    throw new Error("BEHAVIOUR_TEMPORAL_SPLIT_OR_LABEL_LEAKAGE");
  }
  const weights = fitLogisticWeights(dataset.training.map(row => ({ input: behaviourFeatureVector(row), label: row.label })), BEHAVIOUR_FEATURE_NAMES.length);
  const model = validateBehaviourModel({ schemaVersion: 1, featureSchema: "behaviour-v1", modelVersion: dataset.modelVersion,
    datasetId: dataset.datasetId, datasetHash: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
    currency: dataset.currency, synthetic: dataset.synthetic, trainingRows: dataset.training.length,
    trainingCutoff: new Date(training.lastLabel).toISOString(), weights });
  return { model, evaluation: { split: "strict_chronological_label_availability", validation: evaluateBehaviourModel(model, dataset.validation),
    test: evaluateBehaviourModel(model, dataset.test), warning: dataset.synthetic ? "synthetic_demonstration_not_fraud_validation" : "labels_and_provenance_require_independent_review" } };
}
