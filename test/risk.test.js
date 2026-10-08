import test from "node:test";
import assert from "node:assert/strict";
import { trainRiskModel, predictRisk, validateRiskModel, evaluateRiskModel } from "../dist/risk/logisticRisk.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { createPaymentContext } from "../dist/pipeline/context.js";
import { MemoryOutbox } from "../dist/pipeline/outbox.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const metadata = { modelVersion: "synthetic-test-v1", datasetId: "unit-fixture", currency: "INR", synthetic: true };
const training = Array.from({ length: 30 }, (_, index) => index % 2 === 0
  ? { amountMinor: 100 + index, channel: "online", label: 0 }
  : { amountMinor: 1_000_000 + index, channel: "nfc", label: 1 });
const validation = [
  { amountMinor: 150, channel: "online", label: 0 },
  { amountMinor: 1_100_000, channel: "qr", label: 1 },
];

test("logistic regression learns from labels and evaluates separate synthetic examples", () => {
  const model = trainRiskModel(training, metadata);
  const low = predictRisk(model, validation[0]);
  const high = predictRisk(model, validation[1]);
  assert.ok(low.probability < 0.5);
  assert.ok(high.probability > 0.5);
  assert.equal(low.contributions.length, 3);
  assert.equal(model.synthetic, true);
  const evaluation = evaluateRiskModel(model, validation);
  assert.ok(evaluation.logLoss < Math.log(2));
  assert.ok(evaluation.brierScore < 0.25);
  assert.equal(evaluation.recall, 1);
});

test("risk models reject corrupt weights, missing provenance and invalid labels", () => {
  const model = trainRiskModel(training, metadata);
  assert.throws(() => validateRiskModel({ ...model, weights: [0, Infinity, 1] }));
  assert.throws(() => validateRiskModel({ ...model, synthetic: undefined }));
  assert.throws(() => validateRiskModel({ ...model, datasetId: "" }));
  assert.throws(() => trainRiskModel(training.map((row) => ({ ...row, label: 0 })), metadata));
  assert.throws(() => predictRisk(model, { amountMinor: -10, channel: "nfc" }));
});

test("risk predictions do not depend on caller-selected transaction identifiers", () => {
  const model = trainRiskModel(training, metadata);
  assert.deepEqual(predictRisk(model, { ...validation[0], txId: "first_id" }),
    predictRisk(model, { ...validation[0], txId: "different_id" }));
});

test("ML shadow observations cannot authorize or fund a payment", async () => {
  const model = trainRiskModel(training, metadata);
  const outbox = new MemoryOutbox();
  const txn = { txId: "risk_test_001", idempotencyKey: "risk_idem_001", senderWalletId: "sender",
    receiverWalletId: "receiver", amountMinor: 1_100_000, currency: "INR", channel: "online",
    authorizationId: "auth_risk_001", createdAt: "2026-10-08T00:00:00.000Z" };
  const context = createPaymentContext("trace", "correlation", txn, outbox);
  await assert.rejects(buildHardenedPaymentPipeline(noopTracer, undefined, model)(context),
    { message: "db_not_initialized" });
  assert.equal(context.result, undefined);
  assert.equal(context.risk.decision, "allow");
  const observation = outbox.drain().find((event) => event.type === "risk.shadow_assessed");
  assert.equal(observation.payload.mode, "shadow");
  assert.equal(observation.payload.synthetic, true);
});

test("training command writes a reloadable artifact and refuses to overwrite it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rail-risk-"));
  try {
    const input = join(directory, "dataset.json");
    const output = join(directory, "model.json");
    await writeFile(input, JSON.stringify({ ...metadata, training, validation }));
    const result = JSON.parse(execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { encoding: "utf8" }));
    const artifact = await readFile(output, "utf8");
    assert.equal(validateRiskModel(JSON.parse(artifact)).modelVersion, metadata.modelVersion);
    assert.equal(result.mode, "shadow");
    assert.equal(result.evaluation.rows, validation.length);
    assert.throws(() => execFileSync(process.execPath, ["dist/risk/trainRisk.js", input, output], { stdio: "pipe" }));
    assert.equal(await readFile(output, "utf8"), artifact);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
