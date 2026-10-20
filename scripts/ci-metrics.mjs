import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function summarizeTap(tap) {
  const number = name => {
    const values = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
    return values.length ? Number(values.at(-1)[1]) : null;
  };
  return { tests: number("tests"), passed: number("pass"), failed: number("fail"), skipped: number("skipped") };
}

export function summarizeLcov(lcov) {
  const totals = { lines: 0, linesHit: 0, functions: 0, functionsHit: 0, branches: 0, branchesHit: 0, observedFiles: 0 };
  for (const record of lcov.split("end_of_record")) {
    const file = /^SF:(.+)$/m.exec(record)?.[1]?.replaceAll("\\", "/");
    if (!file || !/(^|\/)dist\//.test(file) || /(^|\/)node_modules\//.test(file)) continue;
    totals.observedFiles++;
    for (const [field, label] of Object.entries({ lines: "LF", linesHit: "LH", functions: "FNF", functionsHit: "FNH", branches: "BRF", branchesHit: "BRH" }))
      totals[field] += Number(new RegExp(`^${label}:(\\d+)$`, "m").exec(record)?.[1] ?? 0);
  }
  const percent = (hit, total) => total ? Number((100 * hit / total).toFixed(2)) : null;
  return { ...totals, linePercent: percent(totals.linesHit, totals.lines), functionPercent: percent(totals.functionsHit, totals.functions),
    branchPercent: percent(totals.branchesHit, totals.branches) };
}

async function optional(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function main(mode) {
  const directory = process.env.CI_METRICS_DIR ?? (process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP, "rail-ci") : undefined);
  if (!directory) throw new Error("CI_METRICS_DIR_OR_RUNNER_TEMP_REQUIRED");
  await mkdir(directory, { recursive: true });
  if (mode === "summary") {
    const results = {};
    for (const name of ["backend", "browser"]) {
      const saved = await optional(resolve(directory, `${name}.json`));
      results[name] = saved ? JSON.parse(saved) : null;
    }
    await writeFile(resolve(directory, "metrics.json"), JSON.stringify(results, null, 2));
    const lines = ["## Rail CI Metrics", "", `Runtime: ${process.version}`, "", "| Suite | Result | Tests | Passed | Failed | Skipped | Seconds |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: |"];
    for (const [name, result] of Object.entries(results))
      lines.push(result ? `| ${name} | ${result.success ? "passed" : "failed/incomplete"} | ${result.tests ?? "unknown"} | ${result.passed ?? "unknown"} | ${result.failed ?? "unknown"} | ${result.skipped ?? "unknown"} | ${result.durationSeconds} |`
        : `| ${name} | not run / no report | - | - | - | - | - |`);
    const coverage = results.backend?.coverage;
    if (coverage) {
      const display = value => value === null ? "unavailable" : `${value}%`;
      lines.push("", `Observed application coverage (${coverage.observedFiles} compiled modules): lines ${display(coverage.linePercent)}, functions ${display(coverage.functionPercent)}, branches ${display(coverage.branchPercent)}.`);
    }
    lines.push("", "Coverage is informational, backend-only and limited to observed dist modules; unimported modules and killed subprocesses may be absent. These are test metrics, not production throughput, security certification or real-provider acceptance.", "");
    const summary = lines.join("\n");
    await writeFile(resolve(directory, "summary.md"), summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    process.stdout.write(summary);
    return;
  }
  if (!["backend", "browser"].includes(mode)) throw new Error("INVALID_CI_METRICS_MODE");
  const files = mode === "backend" ? (await readdir("test")).filter(file => file.endsWith(".test.js")).sort().map(file => `test/${file}`)
    : ["test/ownerPasskeys.browser.mjs"];
  const tapPath = resolve(directory, `${mode}.tap`);
  const args = ["--test", "--test-concurrency=2", "--test-reporter=tap", `--test-reporter-destination=${tapPath}`,
    "--test-reporter=junit", `--test-reporter-destination=${resolve(directory, `${mode}.junit.xml`)}`];
  if (mode === "backend") args.push("--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${resolve(directory, "backend.lcov")}`);
  const started = performance.now();
  const child = spawn(process.execPath, [...args, ...files], { stdio: "inherit" });
  const exitCode = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", code => resolveExit(code ?? 1)); });
  const tap = await optional(tapPath) ?? "";
  const counts = summarizeTap(tap);
  const success = exitCode === 0 && counts.tests > 0 && counts.passed === counts.tests && counts.failed === 0 && counts.skipped === 0;
  const result = { suite: mode, node: process.version, ...counts, exitCode, success, durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    ...(mode === "backend" ? { coverage: summarizeLcov(await optional(resolve(directory, "backend.lcov")) ?? "") } : {}) };
  await writeFile(resolve(directory, `${mode}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(tap);
  process.exitCode = success ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
