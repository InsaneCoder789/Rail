import process from "node:process";
import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { MemoryOutbox } from "../pipeline/outbox.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { PostgresIdempotencyStore } from "../persistence/postgresIdempotency.js";
import { createPool } from "../persistence/postgresPool.js";
import { runMigrations } from "../persistence/migrate.js";
import { createAuthorization, initAuthorizationWallet } from "../stages/authorizationStage.js";
import { buildHardenedPaymentPipeline, initLedger } from "../stages/paymentPipeline.js";
import type { PaymentTransaction } from "../domain/types.js";

const databaseUrl = process.env.DATABASE_URL;
const signingSecret = process.env.RAIL_SIGNING_SECRET ?? "";

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for npm run demo");
}

if (!signingSecret) {
  throw new Error("RAIL_SIGNING_SECRET is required for npm run demo");
}

const pool = createPool(databaseUrl);
await runMigrations(pool);
initAuthorizationWallet(pool);
initLedger(pool);

await pool.query(
  `INSERT INTO wallets (wallet_id, balance, reserved)
   VALUES
     ('wal_sender_demo', 100000, 0),
     ('wal_receiver_demo', 0, 0)
   ON CONFLICT (wallet_id) DO NOTHING`,
);

const tracer = consoleTracer("[demo]");
const outbox = new MemoryOutbox();
const idempotency = new PostgresIdempotencyStore(pool);
const dlq = new MemoryDeadLetterQueue();

const engine = new PaymentPipelineEngine({
  idempotency,
  outbox,
  tracer,
  dlq,
  pipeline: buildHardenedPaymentPipeline(tracer),
});

const authorization = await createAuthorization({
  txId: "txn_demo_001",
  senderWalletId: "wal_sender_demo",
  receiverWalletId: "wal_receiver_demo",
  amountMinor: 15_000,
  currency: "INR",
});

const txn: PaymentTransaction = {
  txId: "txn_demo_001",
  idempotencyKey: "idem_demo_001",
  authorizationId: authorization.authId,
  senderWalletId: "wal_sender_demo",
  receiverWalletId: "wal_receiver_demo",
  amountMinor: 15_000,
  currency: "INR",
  channel: "online",
  createdAt: new Date().toISOString(),
};

const result = await engine.execute(txn);
console.log("demo.authorization", authorization);
console.log("demo.result", result);

const cached = await engine.execute(txn);
console.log("demo.cached_retry", cached);

await pool.end();
