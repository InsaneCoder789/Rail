import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { loadTransactionKeyRing } from "../crypto/transactionProtection.js";
import { TransactionEvidenceStore } from "./transactionEvidence.js";
import { RiskProtectionStore, loadRiskKeyRing } from "./riskProtection.js";
import { AuditBatchStore } from "./auditBatches.js";

dotenv.config();
async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL_REQUIRED");
  const paymentKeys = loadTransactionKeyRing(process.env.RAIL_EVIDENCE_KEY_RING);
  const riskKeys = loadRiskKeyRing(process.env.RAIL_RISK_RECORD_KEY_RING, paymentKeys);
  const rawLimit = process.env.RAIL_AUDIT_BATCH_SIZE ?? "128";
  if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 256) throw new Error("INVALID_AUDIT_BATCH_LIMIT");
  const pool = createPool(databaseUrl, 1);
  try {
    console.log(JSON.stringify(await new AuditBatchStore(pool, new TransactionEvidenceStore(paymentKeys),
      new RiskProtectionStore(riskKeys)).createBatch(Number(rawLimit))));
  } finally { await pool.end(); }
}
await run().catch(() => {
  // SQL errors can contain private identifiers; detailed diagnosis belongs in controlled operator tooling.
  console.error("audit_batch_failed");
  process.exitCode = 1;
});
