import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTap, summarizeLcov } from "../scripts/ci-metrics.mjs";

test("CI metrics distinguish missing reports from a successful zero-failure run", () => {
  assert.deepEqual(summarizeTap(""), { tests: null, passed: null, failed: null, skipped: null });
  assert.deepEqual(summarizeTap("# tests 3\n# pass 2\n# fail 1\n# skipped 0\n"), { tests: 3, passed: 2, failed: 1, skipped: 0 });
});

test("CI coverage counts only observed application modules, excluding tests and dependencies", () => {
  const record = file => `SF:${file}\nLF:10\nLH:5\nFNF:4\nFNH:3\nBRF:2\nBRH:1\nend_of_record\n`;
  const report = summarizeLcov(record("dist/server.js") + record("/repo/dist/worker.js") + record("test/a.js") + record("node_modules/pkg/dist/index.js"));
  assert.deepEqual(report, { observedFiles: 2, lines: 20, linesHit: 10, functions: 8, functionsHit: 6, branches: 4, branchesHit: 2,
    linePercent: 50, functionPercent: 75, branchPercent: 50 });
});

test("missing coverage stays unavailable instead of reporting fabricated percentages", () => {
  const report = summarizeLcov("");
  assert.equal(report.observedFiles, 0); assert.equal(report.linePercent, null);
  assert.equal(report.functionPercent, null); assert.equal(report.branchPercent, null);
});
