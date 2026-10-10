import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { findReconciliationIssues, recordWalletOpeningBalance } from "./reconciliation.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const args = process.argv.slice(2);
if (args.length && (args.length !== 4 || args[0] !== "--record-opening")) throw new Error("expected --record-opening walletId amountMinor evidenceReference");
if (args.length && process.env.RAIL_ACCOUNTING_OPERATOR !== "true") throw new Error("ACCOUNTING_OPERATOR_REQUIRED");
const pool = createPool(databaseUrl, 1);
try {
  if (args.length) await recordWalletOpeningBalance(pool, args[1], Number(args[2]), args[3]);
  const issues = await findReconciliationIssues(pool);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), issues }));
  if (issues.length) process.exitCode = 1;
} finally {
  await pool.end();
}
