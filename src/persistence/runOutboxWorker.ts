import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { dispatchOutboxBatch } from "./outboxWorker.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const endpoint = process.env.RAIL_OUTBOX_WEBHOOK_URL;
const secret = process.env.RAIL_OUTBOX_WEBHOOK_SECRET;
if (!databaseUrl || !endpoint || !secret || secret.trim().length < 32) throw new Error("OUTBOX_WORKER_CONFIGURATION_REQUIRED");
const target = new URL(endpoint);
if (target.protocol !== "https:" || target.username || target.password) throw new Error("OUTBOX_WEBHOOK_REQUIRES_HTTPS_WITHOUT_URL_CREDENTIALS");
const pool = createPool(databaseUrl, 1);
try {
  const result = await dispatchOutboxBatch(pool, async (event, signal) => {
    const response = await fetch(target, { method: "POST", signal, redirect: "error", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${secret}`, "Idempotency-Key": event.deliveryId,
    }, body: JSON.stringify(event) });
    await response.body?.cancel();
    if (!response.ok) throw new Error("webhook_delivery_failed");
  });
  console.log(JSON.stringify(result));
  if (result.failed > 0 || result.lostLease > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
