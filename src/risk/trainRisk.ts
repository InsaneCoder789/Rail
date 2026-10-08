import { readFile, writeFile } from "node:fs/promises";
import { evaluateRiskModel, trainRiskModel, type RiskExample } from "./logisticRisk.js";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || inputPath === outputPath) {
  throw new Error("usage: npm run risk:train -- dataset.json model.json (different files)");
}
const dataset = JSON.parse(await readFile(inputPath, "utf8"));
if (!Array.isArray(dataset.training) || !Array.isArray(dataset.validation)) {
  throw new Error("DATASET_REQUIRES_SEPARATE_TRAINING_AND_VALIDATION_ARRAYS");
}
const model = trainRiskModel(dataset.training as RiskExample[], {
  modelVersion: dataset.modelVersion, datasetId: dataset.datasetId,
  currency: dataset.currency, synthetic: dataset.synthetic,
});
const evaluation = evaluateRiskModel(model, dataset.validation as RiskExample[]);
await writeFile(outputPath, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ mode: "shadow", modelVersion: model.modelVersion, synthetic: model.synthetic, evaluation }, null, 2));
