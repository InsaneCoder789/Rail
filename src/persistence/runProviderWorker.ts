import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { ProviderTargetRegistry } from "../domain/providerTargets.js";
import { dispatchProviderBatch, LocalPaymentSimulator } from "./providerWorker.js";
import { AgentEvidenceStore, loadAgentAuthorityKeyRing } from "./agentEvidence.js";
import { loadTransactionKeyRing } from "../crypto/transactionProtection.js";
import { loadRiskKeyRing } from "./riskProtection.js";

dotenv.config({ quiet: true });
if (process.env.RAIL_PROVIDER_SIMULATOR !== "true" || process.env.RAIL_DEMO_MODE !== "true" || process.env.NODE_ENV === "production" || !process.env.DATABASE_URL)
  throw new Error("LOCAL_PROVIDER_SIMULATOR_CONFIGURATION_REQUIRED");
const targets = new ProviderTargetRegistry(process.env.RAIL_PROVIDER_TARGETS);
const paymentKeys = loadTransactionKeyRing(process.env.RAIL_EVIDENCE_KEY_RING);
const riskKeys = loadRiskKeyRing(process.env.RAIL_RISK_RECORD_KEY_RING, paymentKeys);
const evidence = new AgentEvidenceStore(loadAgentAuthorityKeyRing(process.env.RAIL_AGENT_AUTHORITY_KEY_RING ?? "", [paymentKeys, riskKeys]));
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const result = await dispatchProviderBatch(pool, targets, new LocalPaymentSimulator(pool), { evidence });
  console.log(JSON.stringify({ simulatorOnly: true, ...result }));
  if (result.pending || result.lostLease) process.exitCode = 1;
} finally { await pool.end(); }
