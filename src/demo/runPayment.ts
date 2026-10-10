import dotenv from "dotenv";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { noopTracer } from "../pipeline/tracing.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { runMigrations, ensureOutboxSchema } from "../persistence/migrate.js";
import { findReconciliationIssues } from "../persistence/reconciliation.js";
import { createAuthorization } from "../stages/authorizationStage.js";
import { buildHardenedPaymentPipeline } from "../stages/paymentPipeline.js";
import type { PaymentTransaction } from "../domain/types.js";

dotenv.config();

/** Synthetic money is confined to a newly created schema, never existing wallets. */
export async function runPaymentDemo() {
  if (process.env.NODE_ENV === "production" || process.env.RAIL_DEMO_MODE !== "true") {
    throw new Error("DEMO_REQUIRES_EXPLICIT_NON_PRODUCTION_MODE");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required for npm run demo");
  if (!process.env.RAIL_SIGNING_SECRET) throw new Error("RAIL_SIGNING_SECRET is required for npm run demo");

  // The identifier is generated here, not derived from user-supplied SQL input.
  const schema = `rail_demo_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60_000 });
  admin.on("error", () => { console.error("demo_admin_connection_error"); });
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60_000,
      options: `-c search_path=${schema}` });
    pool.on("error", () => { console.error("demo_connection_error"); });
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
    await pool.query(`INSERT INTO wallets (wallet_id, balance, reserved)
      VALUES ('wal_sender_demo', 100000, 0), ('wal_receiver_demo', 0, 0)`);

    const engine = new PaymentPipelineEngine({
      idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
      dlq: new MemoryDeadLetterQueue(), pipeline: buildHardenedPaymentPipeline(noopTracer),
    });
    const authorization = await createAuthorization({
      txId: "txn_demo_001", senderWalletId: "wal_sender_demo", receiverWalletId: "wal_receiver_demo",
      amountMinor: 15000, currency: "INR",
    }, pool);
    const txn: PaymentTransaction = {
      txId: "txn_demo_001", idempotencyKey: "idem_demo_001", authorizationId: authorization.authId,
      senderWalletId: "wal_sender_demo", receiverWalletId: "wal_receiver_demo", amountMinor: 15000,
      currency: "INR", channel: "online", createdAt: new Date().toISOString(),
    };
    const result = await engine.execute(txn);
    const cached = await engine.execute(txn);
    const wallets = await pool.query("SELECT wallet_id, balance::text, reserved::text FROM wallets ORDER BY wallet_id");
    const issues = await findReconciliationIssues(pool);
    if (issues.length || result.status !== "accepted" || !isDeepStrictEqual(result, cached)) {
      throw new Error("demo_acceptance_failed");
    }
    return { result, cached, wallets: wallets.rows, reconciliationIssues: issues.length };
  } finally {
    try {
      await pool?.end();
      // Only drop the schema this invocation successfully created.
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await admin.end(); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log("demo.acceptance", JSON.stringify(await runPaymentDemo()));
}
