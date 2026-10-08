import { createHash } from "node:crypto";
import type { PaymentContext } from "../pipeline/context.js";
import { PipelineError } from "../pipeline/errors.js";
import { Semaphore } from "../pipeline/backpressure.js";
import { runParallelBounded } from "../pipeline/parallel.js";
import { runSequential, type Stage } from "../pipeline/stage.js";
import { withSpan } from "../pipeline/middleware.js";
import type { Tracer } from "../pipeline/tracing.js";
import { canonicalTransactionPayload, verifyTransactionSignatureIfRequired } from "../crypto/transactionSigning.js";
import type { IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import { claimAuthorizationForExecution, consumeReservation, creditWallet, verifyCommittedAuthorization } from "./authorizationStage.js";
import { predictRisk, type LogisticRiskModel } from "../risk/logisticRisk.js";
import { isPaymentTransaction } from "../server/validation.js";

function emitStage(ctx: PaymentContext, stage: string, status: "start" | "ok" | "error"): void {
  const sequence = Number(ctx.state.eventSequence ?? 0) + 1;
  ctx.state.eventSequence = sequence;
  ctx.outbox.append({ type: "pipeline.stage", payload: {
    stage, status, txId: ctx.txn.txId, senderWalletId: ctx.txn.senderWalletId,
    receiverWalletId: ctx.txn.receiverWalletId, sequence,
  } });
}

async function validateBasics(ctx: PaymentContext): Promise<void> {
  emitStage(ctx, "validate.core", "start");
  if (!isPaymentTransaction(ctx.txn)) throw new PipelineError("invalid_transaction", "INVALID_TRANSACTION");
  if (ctx.txn.senderWalletId === ctx.txn.receiverWalletId) throw new PipelineError("self_transfer", "SELF_TRANSFER");
  if (!ctx.txn.authorizationId) throw new PipelineError("authorization_required", "MISSING_AUTH_ID");
  emitStage(ctx, "validate.core", "ok");
}

function riskScoreStage(model?: LogisticRiskModel): Stage {
  return async (ctx) => {
    emitStage(ctx, "risk.score", "start");
    ctx.risk = { score: 0, decision: "allow", reasons: ["no_fraud_policy_configured"] };
    if (model && model.currency === ctx.txn.currency) {
      const prediction = predictRisk(model, ctx.txn);
      ctx.outbox.append({ type: "risk.shadow_assessed", payload: {
        txId: ctx.txn.txId, senderWalletId: ctx.txn.senderWalletId,
        modelVersion: model.modelVersion, synthetic: model.synthetic,
        mode: "shadow", probability: prediction.probability, contributions: prediction.contributions,
      } });
    }
    emitStage(ctx, "risk.score", "ok");
  };
}

/** Mutations use only the transaction supplied by the durable idempotency boundary. */
function transferAndLedger(tokenStore?: IOfflineTokenStore): Stage {
  return async (ctx) => {
    const client = ctx.dbClient;
    if (!client) throw new Error("db_not_initialized");
    const txn = ctx.txn;
    const fingerprint = createHash("sha256").update(canonicalTransactionPayload(txn)).digest("hex");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payment:${txn.txId}`]);
    const ledger = await client.query("SELECT id FROM ledger_entries WHERE tx_id = $1", [txn.txId]);
    if (ledger.rowCount) {
      const execution = await client.query(
        "SELECT idempotency_key, request_fingerprint, result_json FROM rail_payment_executions WHERE tx_id = $1", [txn.txId]);
      if (execution.rows[0]?.idempotency_key !== txn.idempotencyKey || execution.rows[0]?.request_fingerprint !== fingerprint) {
        throw new PipelineError("PAYMENT_ALREADY_EXECUTED", "PAYMENT_ALREADY_EXECUTED");
      }
      await verifyCommittedAuthorization(client, txn);
      ctx.result = execution.rows[0].result_json;
      return;
    }

    emitStage(ctx, "wallet.transfer", "start");
    await claimAuthorizationForExecution(client, txn.authorizationId!, txn);
    await client.query("INSERT INTO authorization_usage (auth_id, tx_id) VALUES ($1, $2)", [txn.authorizationId, txn.txId]);
    // Both directions acquire wallet locks in the same order to avoid opposing-transfer deadlocks.
    await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) ORDER BY wallet_id FOR UPDATE",
      [[txn.senderWalletId, txn.receiverWalletId]]);
    if (txn.channel !== "online") {
      if (!tokenStore?.supportsTransactions) throw new PipelineError("transactional_offline_store_required", "OFFLINE_TOKEN_STORE_REQUIRED");
      const gate = await tokenStore.beginOfflineSpend(txn, client);
      if (!gate.ok) throw new PipelineError(gate.reason, gate.reason);
    }
    await consumeReservation(client, txn.senderWalletId, txn.amountMinor, txn.currency);
    await creditWallet(client, txn.receiverWalletId, txn.amountMinor, txn.currency);
    emitStage(ctx, "wallet.transfer", "ok");
    emitStage(ctx, "ledger.post", "start");
    await client.query(
      `INSERT INTO ledger_entries (tx_id, wallet_id, entry_type, amount_minor, currency)
       VALUES ($1, $2, 'debit', $4, $5), ($1, $3, 'credit', $4, $5)`,
      [txn.txId, txn.senderWalletId, txn.receiverWalletId, txn.amountMinor, txn.currency]);
    if (txn.channel !== "online") await tokenStore!.finalizeOfflineSpend(txn, client);
    const result = { status: "accepted" as const, ledgerEntryId: `leg_${txn.txId}` };
    await client.query(
      `INSERT INTO rail_payment_executions (tx_id, idempotency_key, request_fingerprint, result_json)
       VALUES ($1, $2, $3, $4::jsonb)`, [txn.txId, txn.idempotencyKey, fingerprint, JSON.stringify(result)]);
    ctx.outbox.append({ type: "payments.ledger_posted", payload: {
      txId: txn.txId, amountMinor: txn.amountMinor, currency: txn.currency, channel: txn.channel,
      offline: txn.channel !== "online", senderWalletId: txn.senderWalletId, receiverWalletId: txn.receiverWalletId,
    } });
    emitStage(ctx, "ledger.post", "ok");
    emitStage(ctx, "payment.execute", "ok");
    ctx.result = result;
  };
}

export function buildHardenedPaymentPipeline(tracer: Tracer, tokenStore?: IOfflineTokenStore, riskModel?: LogisticRiskModel): Stage {
  const limiter = new Semaphore(4);
  const parallelChecks: Stage = (ctx) => runParallelBounded([
    withSpan(tracer, "verify.signatures", async (context) => verifyTransactionSignatureIfRequired(context.txn)),
    withSpan(tracer, "risk.score", riskScoreStage(riskModel)),
  ], ctx, limiter);
  return (ctx) => runSequential([
    withSpan(tracer, "validate.core", validateBasics),
    withSpan(tracer, "prechecks.parallel", parallelChecks),
    withSpan(tracer, "funds_and_ledger.transaction", transferAndLedger(tokenStore)),
  ], ctx);
}

export function buildDefaultPaymentPipeline(tracer: Tracer): Stage {
  return buildHardenedPaymentPipeline(tracer);
}
