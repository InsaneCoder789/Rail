import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { monitorBehaviourRisk } from "../dist/risk/behaviourMonitoring.js";

const model = { schemaVersion: 1, featureSchema: "behaviour-v1", modelVersion: "synthetic-monitoring-fixture",
  datasetId: "synthetic-only", datasetHash: "a".repeat(64), currency: "INR", synthetic: true, trainingRows: 20,
  trainingCutoff: "2025-01-01T00:00:00.000Z", weights: [-2, 0, 0, 5, 0, 0, 2, 0, 0, 0] };

function cohort(start, count = 20, changed = false) {
  return Array.from({ length: count }, (_, index) => ({ eventId: `private_event_${start}_${index}`, amountMinor: 100, channel: "online", currency: "INR",
    features: { schemaVersion: 1, observedAt: new Date(Date.UTC(2026, 0, 1 + start + index)).toISOString(),
      source: "postgres_posted_payments", historyWindowDays: 30, historyCount: 20, historyTruncated: false,
      recentCount: changed ? 20 : 0, receiverSeen: true, meanAmountMinor: 100, amountRatio: 1, amountZScore: 0,
      agentBudgetExposure: 0.2, deviceChange: "not_assessed" } }));
}
function data(changed = false) { return { model, reference: cohort(0), current: cohort(30, 20, changed) }; }

test("behaviour monitoring reports identical cohorts without implying fraud safety or calibrated accuracy", () => {
  const report = monitorBehaviourRisk(data());
  assert.equal(report.status, "no_shift_detected");
  assert.equal(report.prediction.psi, 0);
  assert.ok(report.features.every(feature => feature.psi === 0));
  assert.equal(report.features.length, 9);
  assert.equal(report.synthetic, true);
  assert.equal(report.calibrationStatus, "unavailable_without_independent_outcome_labels");
  assert.ok(!JSON.stringify(report).includes("private_event"));
  assert.ok(!JSON.stringify(report).includes("observedAt"));
});

test("behaviour monitoring detects velocity and prediction shifts without mutating models or cohorts", () => {
  const input = data(true), before = structuredClone(input);
  const report = monitorBehaviourRisk(input);
  assert.equal(report.status, "shift_detected");
  assert.ok(report.features.find(feature => feature.feature === "recent_velocity").psi >= 0.2);
  assert.equal(report.prediction.shifted, true);
  assert.ok(report.features.every(feature => Number.isFinite(feature.psi) && feature.psi >= 0));
  assert.deepEqual(input, before);
});

test("behaviour monitoring refuses to conclude stability from insufficient cohorts", () => {
  const report = monitorBehaviourRisk({ model, reference: cohort(0, 5), current: cohort(30, 5) });
  assert.equal(report.status, "insufficient_data");
  assert.equal(report.prediction, null);
  assert.deepEqual(report.features, []);
});

test("behaviour monitoring validates non-overlapping ordered time, IDs, currencies and bounded provenance", () => {
  const changes = [
    input => { input.current[0].eventId = input.reference[0].eventId; },
    input => { input.current = cohort(10); },
    input => { input.reference.reverse(); },
    input => { input.current[0].currency = "USD"; },
    input => { input.current[0].features.source = "client_claim"; },
    input => { input.current[0].features.observedAt = model.trainingCutoff; },
    input => { input.current[0].features.recentCount = 999; },
    input => { input.current = []; },
    input => { input.reference = Array(10001).fill(input.reference[0]); },
  ];
  for (const change of changes) { const input = structuredClone(data()); change(input); assert.throws(() => monitorBehaviourRisk(input)); }
});

test("behaviour monitoring reports growing missingness and finite empty-bucket smoothing", () => {
  const input = data();
  input.current = input.current.map(row => ({ ...row, features: { ...row.features, historyCount: 0, recentCount: 0,
    receiverSeen: false, meanAmountMinor: null, amountRatio: null, amountZScore: null, agentBudgetExposure: null } }));
  const report = monitorBehaviourRisk(input);
  assert.equal(report.status, "shift_detected");
  assert.equal(report.missingness.current.incompleteHistoryRate, 1);
  assert.equal(report.missingness.current.unavailableBudgetRate, 1);
  assert.equal(report.missingness.reference.incompleteHistoryRate, 0);
  assert.ok(report.features.every(feature => Number.isFinite(feature.psi)));
});

test("behaviour monitoring CLI uses diagnostic exit codes and leaves private inputs unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rail-monitor-"));
  try {
    const path = join(directory, "private-cohorts.json");
    for (const [input, expected] of [[data(), 0], [data(true), 2], [{ model, reference: cohort(0, 5), current: cohort(30, 5) }, 3]]) {
      const raw = JSON.stringify(input);
      await writeFile(path, raw, { mode: 0o600 });
      const result = spawnSync(process.execPath, ["dist/risk/monitorRisk.js", path], { encoding: "utf8" });
      assert.equal(result.status, expected, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.scope, "shadow_distribution_diagnostic");
      assert.ok(!result.stdout.includes("private_event"));
      assert.equal(await readFile(path, "utf8"), raw);
    }
    const invalid = spawnSync(process.execPath, ["dist/risk/monitorRisk.js", path, "unexpected"], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.ok(invalid.stderr.includes("usage:"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
