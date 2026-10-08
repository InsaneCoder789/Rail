import type { PaymentTransaction } from "../domain/types.js";

export interface RiskExample {
  readonly amountMinor: number;
  readonly channel: PaymentTransaction["channel"];
  readonly label: 0 | 1;
}

export interface LogisticRiskModel {
  readonly schemaVersion: 1;
  readonly modelVersion: string;
  readonly datasetId: string;
  readonly currency: string;
  readonly synthetic: boolean;
  readonly trainingRows: number;
  readonly weights: readonly [number, number, number];
}

function features(amountMinor: number, channel: PaymentTransaction["channel"]): [number, number, number] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 1_000_000_000_000 ||
      !["online", "nfc", "ble", "qr"].includes(channel)) {
    throw new Error("INVALID_RISK_FEATURES");
  }
  return [1, Math.log1p(amountMinor) / Math.log1p(1_000_000), channel === "online" ? 0 : 1];
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function validateRiskModel(value: unknown): LogisticRiskModel {
  if (!value || typeof value !== "object") throw new Error("INVALID_RISK_MODEL");
  const model = value as LogisticRiskModel;
  if (model.schemaVersion !== 1 || typeof model.modelVersion !== "string" || !model.modelVersion.trim() ||
      typeof model.datasetId !== "string" || !model.datasetId.trim() || typeof model.synthetic !== "boolean" ||
      typeof model.currency !== "string" || !/^[A-Z]{3}$/.test(model.currency) ||
      !Number.isSafeInteger(model.trainingRows) || model.trainingRows < 10 ||
      !Array.isArray(model.weights) || model.weights.length !== 3 ||
      !model.weights.every((weight) => typeof weight === "number" && Number.isFinite(weight) && Math.abs(weight) <= 1_000_000)) {
    throw new Error("INVALID_RISK_MODEL");
  }
  return { ...model, weights: [model.weights[0], model.weights[1], model.weights[2]] };
}

export function predictRisk(model: LogisticRiskModel, example: Pick<RiskExample, "amountMinor" | "channel">): {
  probability: number;
  contributions: readonly number[];
} {
  const input = features(example.amountMinor, example.channel);
  const contributions = input.map((feature, index) => feature * model.weights[index]);
  return { probability: sigmoid(contributions.reduce((sum, value) => sum + value, 0)), contributions };
}

/** Batch gradient descent on binary cross-entropy, with L2 regularization on non-intercept weights. */
export function trainRiskModel(examples: readonly RiskExample[], metadata: {
  modelVersion: string; datasetId: string; currency: string; synthetic: boolean;
}): LogisticRiskModel {
  if (examples.length < 10 || !examples.some((row) => row.label === 0) || !examples.some((row) => row.label === 1)) {
    throw new Error("RISK_TRAINING_REQUIRES_TEN_ROWS_AND_BOTH_CLASSES");
  }
  const rows = examples.map((row) => {
    if (row.label !== 0 && row.label !== 1) throw new Error("INVALID_RISK_LABEL");
    return { input: features(row.amountMinor, row.channel), label: row.label };
  });
  const weights: [number, number, number] = [0, 0, 0];
  for (let epoch = 0; epoch < 1500; epoch++) {
    const gradient = [0, 0, 0];
    for (const row of rows) {
      const error = sigmoid(row.input.reduce((sum, feature, index) => sum + feature * weights[index], 0)) - row.label;
      row.input.forEach((feature, index) => { gradient[index] += error * feature; });
    }
    weights.forEach((weight, index) => {
      weights[index] -= 0.1 * (gradient[index] / rows.length + (index === 0 ? 0 : 0.01 * weight));
    });
  }
  return validateRiskModel({ schemaVersion: 1, ...metadata, trainingRows: rows.length, weights });
}

export function evaluateRiskModel(model: LogisticRiskModel, examples: readonly RiskExample[]) {
  if (examples.length < 2 || !examples.some((row) => row.label === 0) || !examples.some((row) => row.label === 1)) {
    throw new Error("RISK_EVALUATION_REQUIRES_BOTH_CLASSES");
  }
  let logLoss = 0;
  let brierScore = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const example of examples) {
    if (example.label !== 0 && example.label !== 1) throw new Error("INVALID_RISK_LABEL");
    const { probability } = predictRisk(model, example);
    const clipped = Math.max(1e-12, Math.min(1 - 1e-12, probability));
    logLoss -= example.label * Math.log(clipped) + (1 - example.label) * Math.log(1 - clipped);
    brierScore += (probability - example.label) ** 2;
    if (probability >= 0.5 && example.label === 1) truePositives++;
    if (probability >= 0.5 && example.label === 0) falsePositives++;
    if (probability < 0.5 && example.label === 1) falseNegatives++;
  }
  return {
    rows: examples.length,
    threshold: 0.5,
    logLoss: logLoss / examples.length,
    brierScore: brierScore / examples.length,
    precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall: truePositives / (truePositives + falseNegatives),
  };
}
