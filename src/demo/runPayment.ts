import type { PaymentTransaction } from "../domain/types.js";
import { MemoryDeadLetterQueue } from "../pipeline/dlq.js";
import { PaymentPipelineEngine } from "../pipeline/engine.js";
import { MemoryIdempotencyStore } from "../pipeline/idempotency.js";
import { MemoryOutbox } from "../pipeline/outbox.js";
import { consoleTracer } from "../pipeline/tracing.js";
import { buildDefaultPaymentPipeline } from "../stages/paymentPipeline.js";

const txn: PaymentTransaction = {
  txId: "txn_demo_001",
  idempotencyKey: "idem_demo_001",
  senderWalletId: "wal_sender",
  receiverWalletId: "wal_receiver",
  amountMinor: 150_00,
  currency: "INR",
  channel: "qr",
  offlineTokenId: "otk_demo",
  createdAt: new Date().toISOString(),
};

const tracer = consoleTracer();
const outbox = new MemoryOutbox();
const idempotency = new MemoryIdempotencyStore();
const dlq = new MemoryDeadLetterQueue();

const engine = new PaymentPipelineEngine({
  idempotency,
  outbox,
  tracer,
  dlq,
  pipeline: buildDefaultPaymentPipeline(tracer),
});

const result = await engine.execute(txn);
console.log("result", result);

// Replay same idempotency key -> cached result, no duplicate outbox publish path inside dedupe
const cached = await engine.execute({ ...txn, txId: "txn_demo_ignored_duplicate" });
console.log("cached", cached);
