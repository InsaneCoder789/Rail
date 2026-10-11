import { writeFile } from "node:fs/promises";
import { evaluateRiskModel, readRiskJson, trainRiskModel, type RiskExample } from "./logisticRisk.js";
import { benchmarkBehaviourModel, trainBehaviourDataset, type BehaviourExample, type BehaviourInput } from "./behaviourModel.js";
import { benchmarkAnomalyModel, trainAnomalyDataset } from "./anomalyRisk.js";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || inputPath === outputPath) {
  throw new Error("usage: npm run risk:train -- dataset.json model.json (different files)");
}
const dataset = await readRiskJson(inputPath, 20 * 1024 * 1024) as Record<string, unknown>;
if (!dataset || typeof dataset !== "object") throw new Error("INVALID_RISK_DATASET");
if (dataset.featureSchema === "behaviour-anomaly-v1") {
  const { model, evaluation } = trainAnomalyDataset(dataset);
  await writeFile(outputPath, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ mode: "shadow", featureSchema: model.featureSchema, modelVersion: model.modelVersion,
    synthetic: model.synthetic, evaluation, benchmark: benchmarkAnomalyModel(model, dataset.test as BehaviourInput[]) }, null, 2));
} else if (dataset.featureSchema === "behaviour-v1") {
  const { model, evaluation } = trainBehaviourDataset(dataset);
  await writeFile(outputPath, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ mode: "shadow", featureSchema: model.featureSchema, modelVersion: model.modelVersion,
    synthetic: model.synthetic, evaluation, benchmark: benchmarkBehaviourModel(model, dataset.test as BehaviourExample[]) }, null, 2));
} else {
  if (dataset.featureSchema !== undefined) throw new Error("UNSUPPORTED_RISK_FEATURE_SCHEMA");
  if (!Array.isArray(dataset.training) || !Array.isArray(dataset.validation)) {
    throw new Error("DATASET_REQUIRES_SEPARATE_TRAINING_AND_VALIDATION_ARRAYS");
  }
  const model = trainRiskModel(dataset.training as RiskExample[], {
    modelVersion: dataset.modelVersion as string, datasetId: dataset.datasetId as string,
    currency: dataset.currency as string, synthetic: dataset.synthetic as boolean,
  });
  const evaluation = evaluateRiskModel(model, dataset.validation as RiskExample[]);
  await writeFile(outputPath, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ mode: "shadow", modelVersion: model.modelVersion, synthetic: model.synthetic, evaluation }, null, 2));
}
