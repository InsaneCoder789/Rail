import { readRiskJson } from "./logisticRisk.js";
import { monitorBehaviourRisk } from "./behaviourMonitoring.js";

const [inputPath, ...extra] = process.argv.slice(2);
if (!inputPath || extra.length) throw new Error("usage: npm run risk:monitor -- /private/path/cohorts.json");
const report = monitorBehaviourRisk(await readRiskJson(inputPath, 20 * 1024 * 1024));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "shift_detected" ? 2 : report.status === "insufficient_data" ? 3 : 0;
