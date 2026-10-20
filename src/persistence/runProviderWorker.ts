import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { ProviderTargetRegistry } from "../domain/providerTargets.js";
import { dispatchProviderBatch, LocalPaymentSimulator } from "./providerWorker.js";

dotenv.config({ quiet: true });
if (process.env.RAIL_PROVIDER_SIMULATOR !== "true" || process.env.RAIL_DEMO_MODE !== "true" || process.env.NODE_ENV === "production" || !process.env.DATABASE_URL)
  throw new Error("LOCAL_PROVIDER_SIMULATOR_CONFIGURATION_REQUIRED");
const targets = new ProviderTargetRegistry(process.env.RAIL_PROVIDER_TARGETS);
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const result = await dispatchProviderBatch(pool, targets, new LocalPaymentSimulator(pool));
  console.log(JSON.stringify({ simulatorOnly: true, ...result }));
  if (result.pending || result.lostLease) process.exitCode = 1;
} finally { await pool.end(); }
