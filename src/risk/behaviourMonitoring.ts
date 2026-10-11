import { createHash } from "node:crypto";
import { BEHAVIOUR_FEATURE_NAMES, behaviourFeatureVector, predictBehaviourRisk, validateBehaviourModel,
  type BehaviourExample, type BehaviourRiskModel } from "./behaviourModel.js";

interface MonitoringEvent extends Pick<BehaviourExample, "eventId" | "amountMinor" | "channel" | "features"> {
  readonly currency: string;
}

const MINIMUM_COHORT_ROWS = 20;
const SHIFT_THRESHOLD = 0.2;
const BUCKETS = 10;

function invalid(): never { throw new Error("INVALID_BEHAVIOUR_MONITORING_DATA"); }

function validateCohort(value: unknown, model: BehaviourRiskModel, ids: Set<string>): readonly MonitoringEvent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10000) invalid();
  let prior = -Infinity;
  for (const row of value as MonitoringEvent[]) {
    if (!row || typeof row.eventId !== "string" || !row.eventId.trim() || row.eventId.length > 128 ||
        ids.has(row.eventId) || row.currency !== model.currency) invalid();
    ids.add(row.eventId);
    behaviourFeatureVector(row);
    const observed = Date.parse(row.features.observedAt);
    if (observed < prior || observed <= Date.parse(model.trainingCutoff)) invalid();
    prior = observed;
  }
  return value;
}

function histogram(values: readonly number[], upperBound: number): number[] {
  const bins = Array<number>(BUCKETS).fill(0);
  for (const value of values) bins[Math.min(BUCKETS - 1, Math.floor(value / upperBound * BUCKETS))]++;
  return bins;
}

function compareDistribution(reference: readonly number[], current: readonly number[], upperBound: number) {
  const oldBins = histogram(reference, upperBound), newBins = histogram(current, upperBound);
  // Half-count smoothing keeps empty buckets finite without hiding the sample sizes.
  const psi = oldBins.reduce((sum, count, index) => {
    const oldRate = (count + 0.5) / (reference.length + BUCKETS * 0.5);
    const newRate = (newBins[index] + 0.5) / (current.length + BUCKETS * 0.5);
    return sum + (newRate - oldRate) * Math.log(newRate / oldRate);
  }, 0);
  return { psi, shifted: psi >= SHIFT_THRESHOLD, upperBound, referenceBuckets: oldBins, currentBuckets: newBins };
}

export function monitorBehaviourRisk(value: unknown) {
  if (!value || typeof value !== "object") invalid();
  const input = value as { model?: unknown; reference?: unknown; current?: unknown };
  const model = validateBehaviourModel(input.model);
  const ids = new Set<string>();
  const reference = validateCohort(input.reference, model, ids), current = validateCohort(input.current, model, ids);
  if (Date.parse(reference[reference.length - 1].features.observedAt) >= Date.parse(current[0].features.observedAt)) {
    throw new Error("BEHAVIOUR_MONITORING_COHORT_OVERLAP");
  }
  const common = { schemaVersion: 1, scope: "shadow_distribution_diagnostic", modelVersion: model.modelVersion,
    modelHash: createHash("sha256").update(JSON.stringify(model)).digest("hex"), synthetic: model.synthetic,
    referenceRows: reference.length, currentRows: current.length, minimumCohortRows: MINIMUM_COHORT_ROWS,
    threshold: SHIFT_THRESHOLD, smoothing: 0.5, calibrationStatus: "unavailable_without_independent_outcome_labels",
    provenanceStatus: "caller_supplied_cohorts_require_independent_review",
    warning: "experimental_shift_threshold_not_fraud_detection_or_release_approval" };
  if (reference.length < MINIMUM_COHORT_ROWS || current.length < MINIMUM_COHORT_ROWS) {
    return { ...common, status: "insufficient_data" as const, features: [], prediction: null };
  }
  const oldVectors = reference.map(row => behaviourFeatureVector(row)), newVectors = current.map(row => behaviourFeatureVector(row));
  const features = BEHAVIOUR_FEATURE_NAMES.slice(1).map((feature, index) => ({ feature,
    ...compareDistribution(oldVectors.map(vector => vector[index + 1]), newVectors.map(vector => vector[index + 1]),
      index + 1 === 1 ? 2 : 1) }));
  const prediction = compareDistribution(reference.map(row => predictBehaviourRisk(model, row).probability),
    current.map(row => predictBehaviourRisk(model, row).probability), 1);
  const missingness = (rows: readonly MonitoringEvent[]) => ({
    incompleteHistoryRate: rows.filter(row => row.features.historyCount < 5 || row.features.historyTruncated).length / rows.length,
    truncatedHistoryRate: rows.filter(row => row.features.historyTruncated).length / rows.length,
    unavailableBudgetRate: rows.filter(row => row.features.agentBudgetExposure === null).length / rows.length,
  });
  return { ...common, status: features.some(feature => feature.shifted) || prediction.shifted ? "shift_detected" as const : "no_shift_detected" as const,
    features, prediction, missingness: { reference: missingness(reference), current: missingness(current) } };
}
