import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BEHAVIOUR_FEATURE_NAMES, behaviourFeatureVector, type BehaviourInput } from "./behaviourModel.js";

const DIMENSIONS = BEHAVIOUR_FEATURE_NAMES.length - 1;
const SCALE_FLOOR = 0.05;
const DISTANCE_CAP = 20;

export interface AnomalyModel {
  readonly schemaVersion: 1;
  readonly featureSchema: "behaviour-anomaly-v1";
  readonly modelVersion: string;
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly referenceSource: "synthetic" | "reviewed_reference";
  readonly trainingRows: number;
  readonly calibrationRows: number;
  readonly trainingCutoff: string;
  readonly centers: readonly number[];
  readonly scales: readonly number[];
  readonly threshold: number;
}
interface AnomalyExample extends BehaviourInput { readonly eventId: string; }
interface AnomalyDataset {
  readonly featureSchema: "behaviour-anomaly-v1";
  readonly modelVersion: string;
  readonly datasetId: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly referenceSource: AnomalyModel["referenceSource"];
  readonly training: readonly AnomalyExample[];
  readonly calibration: readonly AnomalyExample[];
  readonly test: readonly AnomalyExample[];
}

function fail(): never { throw new Error("INVALID_ANOMALY_MODEL_OR_DATA"); }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 128; }
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return Date.parse(value);
}
function quantile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a,b) => a-b);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}
function median(values: readonly number[]): number {
  const ordered = [...values].sort((a,b) => a-b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function vector(input: BehaviourInput): readonly number[] {
  const result = behaviourFeatureVector(input).slice(1);
  if (input.features.historyCount < 5 || input.features.historyTruncated) throw new Error("ANOMALY_HISTORY_UNAVAILABLE");
  return result;
}
export function validateAnomalyModel(value: unknown): AnomalyModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const model = value as AnomalyModel;
  if (model.schemaVersion !== 1 || model.featureSchema !== "behaviour-anomaly-v1" || !text(model.modelVersion) || !text(model.datasetId) ||
      typeof model.datasetHash !== "string" || !/^[a-f0-9]{64}$/.test(model.datasetHash) || typeof model.synthetic !== "boolean" ||
      model.referenceSource !== (model.synthetic ? "synthetic" : "reviewed_reference") || typeof model.currency !== "string" ||
      !/^[A-Z]{3}$/.test(model.currency) || !Number.isSafeInteger(model.trainingRows) || model.trainingRows < 20 || model.trainingRows > 10000 ||
      !Number.isSafeInteger(model.calibrationRows) || model.calibrationRows < 20 || model.calibrationRows > 10000 ||
      !Array.isArray(model.centers) || model.centers.length !== DIMENSIONS || !Array.isArray(model.scales) || model.scales.length !== DIMENSIONS ||
      Array.from(model.centers).some((v, index) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > (index === 0 ? 2 : 1)) ||
      Array.from(model.scales).some(v => typeof v !== "number" || !Number.isFinite(v) || v < SCALE_FLOOR || v > 3) ||
      typeof model.threshold !== "number" || !Number.isFinite(model.threshold) || model.threshold < 3 || model.threshold > DISTANCE_CAP ||
      model.centers[7] !== 0) fail();
  timestamp(model.trainingCutoff);
  return { schemaVersion: 1, featureSchema: model.featureSchema, modelVersion: model.modelVersion, datasetId: model.datasetId,
    datasetHash: model.datasetHash, currency: model.currency, synthetic: model.synthetic, referenceSource: model.referenceSource,
    trainingRows: model.trainingRows, calibrationRows: model.calibrationRows, trainingCutoff: model.trainingCutoff,
    centers: [...model.centers], scales: [...model.scales], threshold: model.threshold };
}
function score(model: AnomalyModel, input: BehaviourInput) {
  const contributions = vector(input).map((value, index) => {
    const deviation = Math.abs(value - model.centers[index]) / model.scales[index];
    return { feature: BEHAVIOUR_FEATURE_NAMES[index + 1], distance: Math.min(DISTANCE_CAP, deviation), clipped: deviation > DISTANCE_CAP };
  });
  const distance = Math.sqrt(contributions.reduce((sum, item) => sum + item.distance ** 2, 0) / DIMENSIONS);
  return { kind: "robust_distance" as const, distance, threshold: model.threshold, unusual: distance > model.threshold, contributions };
}
export function predictAnomaly(model: AnomalyModel, input: BehaviourInput) {
  const artifact = validateAnomalyModel(model);
  if (timestamp(input?.features?.observedAt) <= timestamp(artifact.trainingCutoff)) throw new Error("ANOMALY_TEMPORAL_LEAKAGE");
  return score(artifact, input);
}
export function benchmarkAnomalyModel(model: AnomalyModel, rows: readonly BehaviourInput[], iterations = 1000) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000 || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10000) fail();
  for (let i = 0; i < Math.min(100, iterations); i++) predictAnomaly(model, rows[i % rows.length]);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    predictAnomaly(model, rows[i % rows.length]);
    timings.push(performance.now() - start);
  }
  timings.sort((a,b) => a-b);
  return { scope: "local_anomaly_inference_only", iterations, p50Ms: timings[Math.ceil(iterations * 0.5) - 1],
    p95Ms: timings[Math.ceil(iterations * 0.95) - 1], maxMs: timings[timings.length - 1] };
}
function split(rows: readonly AnomalyExample[], ids: Set<string>) {
  if (!Array.isArray(rows) || rows.length < 20 || rows.length > 10000) fail();
  let prior = -Infinity;
  for (const row of rows) {
    if (!row || !text(row.eventId) || ids.has(row.eventId)) fail();
    ids.add(row.eventId);
    vector(row);
    const observed = timestamp(row.features.observedAt);
    if (observed < prior) fail();
    prior = observed;
  }
  return { first: timestamp(rows[0].features.observedAt), last: prior };
}
function report(model: AnomalyModel, rows: readonly AnomalyExample[]) {
  const predictions = rows.map(row => score(model, row)), distances = predictions.map(item => item.distance);
  return { rows: rows.length, unusualCount: predictions.filter(item => item.unusual).length,
    unusualRate: predictions.filter(item => item.unusual).length / rows.length,
    p50Distance: quantile(distances, 0.5), p95Distance: quantile(distances, 0.95), maxDistance: Math.max(...distances) };
}
export function trainAnomalyDataset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const dataset = value as AnomalyDataset;
  if (dataset.featureSchema !== "behaviour-anomaly-v1" || !text(dataset.modelVersion) || !text(dataset.datasetId) ||
      typeof dataset.currency !== "string" || !/^[A-Z]{3}$/.test(dataset.currency) || typeof dataset.synthetic !== "boolean" ||
      dataset.referenceSource !== (dataset.synthetic ? "synthetic" : "reviewed_reference")) fail();
  const ids = new Set<string>(), training = split(dataset.training, ids), calibration = split(dataset.calibration, ids), test = split(dataset.test, ids);
  if (training.last >= calibration.first || calibration.last >= test.first) throw new Error("ANOMALY_TEMPORAL_SPLIT_LEAKAGE");
  const vectors = dataset.training.map(vector);
  const centers = Array.from({ length: DIMENSIONS }, (_, index) => median(vectors.map(row => row[index])));
  // The floor handles constant/binary dimensions; this scaling makes no Gaussian-population claim.
  const scales = centers.map((center, index) => Math.max(SCALE_FLOOR, 1.4826 * median(vectors.map(row => Math.abs(row[index] - center)))));
  let model = validateAnomalyModel({ schemaVersion: 1, featureSchema: dataset.featureSchema, modelVersion: dataset.modelVersion,
    datasetId: dataset.datasetId, datasetHash: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"), currency: dataset.currency,
    synthetic: dataset.synthetic, referenceSource: dataset.referenceSource, trainingRows: dataset.training.length,
    calibrationRows: dataset.calibration.length, trainingCutoff: new Date(calibration.last).toISOString(), centers, scales, threshold: 3 });
  model = validateAnomalyModel({ ...model, threshold: Math.max(3, quantile(dataset.calibration.map(row => score(model, row).distance), 0.95)) });
  return { model, evaluation: { split: "strict_chronological_reference_calibration_test", calibrationQuantile: 0.95,
    thresholdFloor: 3, calibration: report(model, dataset.calibration), test: report(model, dataset.test),
    warning: dataset.synthetic ? "synthetic_anomaly_demo_not_fraud_validation" : "reference_provenance_and_threshold_require_independent_review",
    accuracy: "unavailable_without_independent_outcome_labels" } };
}
