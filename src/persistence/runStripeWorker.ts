import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { ProviderTargetRegistry } from "../domain/providerTargets.js";
import { dispatchProviderBatch } from "./providerWorker.js";
import { StripeTestProvider, loadStripeTestConfiguration } from "../rail/stripeProvider.js";
import { AgentEvidenceStore, loadAgentAuthorityKeyRing } from "./agentEvidence.js";
import { loadTransactionKeyRing } from "../crypto/transactionProtection.js";
import { loadRiskKeyRing } from "./riskProtection.js";

dotenv.config({ quiet: true });
const configuration = loadStripeTestConfiguration();
if (!configuration || !process.env.DATABASE_URL) throw new Error("STRIPE_TEST_WORKER_CONFIGURATION_REQUIRED");
const targets = new ProviderTargetRegistry(process.env.RAIL_PROVIDER_TARGETS);
const paymentKeys = loadTransactionKeyRing(process.env.RAIL_EVIDENCE_KEY_RING);
const riskKeys = loadRiskKeyRing(process.env.RAIL_RISK_RECORD_KEY_RING, paymentKeys);
const evidence = new AgentEvidenceStore(loadAgentAuthorityKeyRing(process.env.RAIL_AGENT_AUTHORITY_KEY_RING ?? "", [paymentKeys, riskKeys]));
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const result = await dispatchProviderBatch(pool, targets, new StripeTestProvider(configuration), { evidence, leaseMs: 60000, timeoutMs: 20000 });
  console.log(JSON.stringify({ stripeTestOnly: true, ...result }));
  if (result.pending || result.lostLease) process.exitCode = 1;
} finally { await pool.end(); }
