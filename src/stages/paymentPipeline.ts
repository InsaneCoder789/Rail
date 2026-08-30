import type { PaymentContext } from "../pipeline/context.js";
import { PipelineError } from "../pipeline/errors.js";
import { Semaphore } from "../pipeline/backpressure.js";
import { runParallelBounded } from "../pipeline/parallel.js";
import { SagaCoordinator, type SagaStep } from "../pipeline/saga.js";
import { runSequential, type Stage } from "../pipeline/stage.js";
import { withSpan, withRetryStage } from "../pipeline/middleware.js";
import { defaultRetryPolicy } from "../pipeline/retry.js";
import type { Tracer } from "../pipeline/tracing.js";
import { verifyTransactionSignatureIfRequired } from "../crypto/transactionSigning.js";
import type { IOfflineTokenStore } from "../rail/offlineTokenStore.js";
import { claimAuthorizationForExecution, consumeReservation, creditWallet } from "./authorizationStage.js";
import { Pool, PoolClient } from "pg";

let ledgerPool: Pool | null = null;

export function initLedger(pool: Pool) {
  ledgerPool = pool;
}

async function recordLedgerEntry(
  client: any,
  type: "debit" | "credit",
  walletId: string,
  amount: number,
  txId: string,
  currency: string,
) {
  await client.query(
    `INSERT INTO ledger_entries (tx_id, wallet_id, entry_type, amount_minor, currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [txId, walletId, type, amount, currency]
  );
}

// Sequence counter for strict event ordering
function nextSeq(ctx: PaymentContext): number {
  if (!(ctx as any)._seq) (ctx as any)._seq = 1;
  return (ctx as any)._seq++;
}

function emitStage(
  ctx: PaymentContext,
  stage: string,
  status: "start" | "ok" | "error"
) {
  const seq = nextSeq(ctx);
  const key = `${stage}:${status}`;
  if (!(ctx as any)._emitted) (ctx as any)._emitted = new Set();
  if ((ctx as any)._emitted.has(key)) return;
  (ctx as any)._emitted.add(key);

  ctx.outbox?.append?.({
    type: "pipeline.stage",
      payload: {
        stage,
        status,
        txId: ctx.txn.txId,
        senderWalletId: ctx.txn.senderWalletId,
        receiverWalletId: ctx.txn.receiverWalletId,
        sequence: seq,
      },
    occurredAt: new Date(Date.now() + seq).toISOString(),
  } as any);
}

function validateBasics(ctx: PaymentContext): Promise<void> {
  emitStage(ctx, "validate.core", "start");
  const { txn } = ctx;
  if (!Number.isSafeInteger(txn.amountMinor) || txn.amountMinor <= 0) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("invalid_amount", "INVALID_AMOUNT", false));
  }
  if (!/^[A-Z]{3}$/.test(txn.currency)) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("invalid_currency", "INVALID_CURRENCY", false));
  }
  if (txn.senderWalletId === txn.receiverWalletId) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("self_transfer", "SELF_TRANSFER", false));
  }
  if ((txn.channel === "nfc" || txn.channel === "ble" || txn.channel === "qr") && !txn.offlineTokenId) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("offline_token_required", "OFFLINE_TOKEN", false));
  }
  if ((txn.channel === "nfc" || txn.channel === "ble" || txn.channel === "qr") && !txn.deviceId) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("offline_device_required", "OFFLINE_DEVICE", false));
  }
  if (txn.channel === "online" && txn.offlineTokenId) {
    emitStage(ctx, "validate.core", "error");
    return Promise.reject(new PipelineError("offline_token_not_allowed_for_online", "OFFLINE_TOKEN_FOR_ONLINE", false));
  }
  emitStage(ctx, "validate.core", "ok");
  return Promise.resolve();
}

/** Simulated flaky verifier: fails once with retryable error (demo only). */
function createSignatureVerifier(): Stage {
  let calls = 0;
  return async () => {
    calls++;
    if (calls === 1) {
      throw new PipelineError("issuer_hsm_throttle", "HSM_THROTTLE", true);
    }
  };
}

/** Production-shaped verifier: optional HMAC (env) today; swap for PKCS#11/KMS in `crypto/hsm.ts`. */
function createStableSignatureVerifier(): Stage {
  return async (ctx) => {
    await verifyTransactionSignatureIfRequired(ctx.txn);
  };
}

function riskScoreStage(): Stage {
  return async (ctx) => {
    emitStage(ctx, "risk.score", "start");
    const velocity = Math.abs(ctx.txn.txId.charCodeAt(0) % 5);
    const score = 82 - velocity * 3;
    const decision = score >= 75 ? "allow" : score >= 60 ? "challenge" : "block";
    ctx.risk = {
      score,
      decision,
      reasons: [`velocity_hint=${velocity}`],
    };
    if (decision === "block") {
      emitStage(ctx, "risk.score", "error");
      throw new PipelineError("risk_blocked", "RISK_BLOCK", false);
    }
    emitStage(ctx, "risk.score", "ok");
  };
}

function walletSaga(tokenStore?: IOfflineTokenStore): SagaCoordinator {
  const steps: SagaStep[] = [
    {
      name: "wallet.transfer",
      forward: async (ctx) => {
        emitStage(ctx, "wallet.transfer", "start");
        if (!ledgerPool) {
          throw new Error("db_not_initialized");
        }
        const client: PoolClient = await ledgerPool.connect();

        try {
          await client.query("BEGIN");

          const ledgerRows = await client.query(
            `SELECT wallet_id, entry_type, amount_minor, currency
             FROM ledger_entries
             WHERE tx_id = $1
             ORDER BY entry_type`,
            [ctx.txn.txId],
          );
          const hasCompletedLedger =
            ledgerRows.rowCount === 2 &&
            ledgerRows.rows.some((row) =>
              row.wallet_id === ctx.txn.senderWalletId &&
              row.entry_type === "debit" &&
              Number(row.amount_minor) === ctx.txn.amountMinor &&
              row.currency === ctx.txn.currency,
            ) &&
            ledgerRows.rows.some((row) =>
              row.wallet_id === ctx.txn.receiverWalletId &&
              row.entry_type === "credit" &&
              Number(row.amount_minor) === ctx.txn.amountMinor &&
              row.currency === ctx.txn.currency,
            );

          if (hasCompletedLedger) {
            await client.query("COMMIT");
            client.release();
            ctx.state.recoveredCommittedPayment = true;
            emitStage(ctx, "wallet.transfer", "ok");
            return;
          }
          if (ledgerRows.rowCount && ledgerRows.rowCount > 0) {
            throw new Error("INCONSISTENT_LEDGER_STATE");
          }

          if (tokenStore) {
            const gate = await tokenStore.beginOfflineSpend(ctx.txn, client);
            if (!gate.ok) {
              throw new PipelineError(gate.reason, gate.reason, false);
            }
            ctx.state.offlineTokenReserved = ctx.txn.channel !== "online";
          }

          // 🔐 Replay protection
          const authId = ctx.txn.authorizationId;
          if (!authId) {
            throw new Error("MISSING_AUTH_ID");
          }

          await claimAuthorizationForExecution(
            client,
            authId,
            ctx.txn.txId,
          );

          await client.query(
            `INSERT INTO authorization_usage (auth_id, tx_id)
             VALUES ($1, $2)
             ON CONFLICT (auth_id) DO NOTHING`,
            [authId, ctx.txn.txId],
          );

          // 1. Debit sender
          await consumeReservation(
            client,
            ctx.txn.senderWalletId,
            ctx.txn.amountMinor,
            ctx.txn.currency,
          );

          // 2. Credit receiver
          await creditWallet(
            client,
            ctx.txn.receiverWalletId,
            ctx.txn.amountMinor,
            ctx.txn.currency,
          );

          emitStage(ctx, "wallet.transfer", "ok");

          // attach client to context for next stage
          (ctx as any)._dbClient = client;

        } catch (err) {
          emitStage(ctx, "wallet.transfer", "error");
          if (ctx.state.offlineTokenReserved) {
            try {
              await tokenStore?.rollbackOfflineSpend(ctx.txn, client);
            } catch {}
          }
          try {
            await client.query("ROLLBACK");
          } catch {}
          try { client.release(); } catch {}
          throw err;
        }
      },
      compensate: async (ctx) => {
        const client = (ctx as any)._dbClient as PoolClient | undefined;
        if (!client) return;
        try {
          await client.query("ROLLBACK");
        } catch {}
        try {
          client.release();
        } catch {}
      },
    },
    {
      name: "ledger.post",
      forward: async (ctx) => {
        emitStage(ctx, "ledger.post", "start");
        if (ctx.state.recoveredCommittedPayment) {
          emitStage(ctx, "ledger.post", "ok");
          emitStage(ctx, "payment.execute", "ok");
          ctx.result = {
            status: "accepted",
            ledgerEntryId: `leg_${ctx.txn.txId}`,
          };
          return;
        }
        const client = (ctx as any)._dbClient as PoolClient | undefined;
        if (!client) throw new Error("missing_db_client");

        if (ctx.risk?.decision === "challenge") {
          ctx.outbox?.append?.({
            type: "payments.step_up_required",
            payload: {
              txId: ctx.txn.txId,
              correlationId: ctx.correlationId,
              senderWalletId: ctx.txn.senderWalletId,
              receiverWalletId: ctx.txn.receiverWalletId,
            },
            occurredAt: new Date().toISOString(),
          } as any);
        }

        // 🔥 PERSISTENT DOUBLE ENTRY LEDGER
        await recordLedgerEntry(
          client,
          "debit",
          ctx.txn.senderWalletId,
          ctx.txn.amountMinor,
          ctx.txn.txId,
          ctx.txn.currency,
        );

        await recordLedgerEntry(
          client,
          "credit",
          ctx.txn.receiverWalletId,
          ctx.txn.amountMinor,
          ctx.txn.txId,
          ctx.txn.currency,
        );

        // keep event system
        ctx.outbox?.append?.({
          type: "payments.ledger_posted",
          payload: {
            txId: ctx.txn.txId,
            amountMinor: ctx.txn.amountMinor,
            channel: ctx.txn.channel,
            offline: ctx.txn.channel !== "online",
            senderWalletId: ctx.txn.senderWalletId,
            receiverWalletId: ctx.txn.receiverWalletId,
          },
          occurredAt: new Date().toISOString(),
        } as any);

        if (tokenStore) {
          await tokenStore.finalizeOfflineSpend(ctx.txn, client);
        }

        emitStage(ctx, "ledger.post", "ok");

        if (!client) throw new Error("missing_db_client_commit");
        await client.query("COMMIT");
        client.release();

        emitStage(ctx, "payment.execute", "ok");

        ctx.result = {
          status: "accepted",
          ledgerEntryId: `leg_${ctx.txn.txId}`,
        };
      },
      compensate: async (ctx) => {
        emitStage(ctx, "ledger.post", "error");
        const client = (ctx as any)._dbClient as PoolClient | undefined;
        if (client) {
          if (ctx.state.offlineTokenReserved) {
            try {
              await tokenStore?.rollbackOfflineSpend(ctx.txn, client);
            } catch {}
          }
          try {
            await client.query("ROLLBACK");
          } catch {}
          try {
            client.release();
          } catch {}
        }
        ctx.outbox?.append?.({
          type: "payments.ledger_reversed",
          payload: {
            txId: ctx.txn.txId,
            senderWalletId: ctx.txn.senderWalletId,
            receiverWalletId: ctx.txn.receiverWalletId,
          },
          occurredAt: new Date().toISOString(),
        } as any);
        ctx.result = { status: "rejected", reason: "compensated" };
      },
    },
  ];
  return new SagaCoordinator(steps);
}

/**
 * Advanced composition: bounded parallel pre-checks, retryable IO, saga for funds + ledger, outbox side-effects.
 */
function buildPipelineWithVerifier(tracer: Tracer, signatureStage: Stage, tokenStore?: IOfflineTokenStore): Stage {
  const limiter = new Semaphore(4);
  const saga = walletSaga(tokenStore);

  const parallelChecks: Stage = async (ctx) => {
    // enforce deterministic emit order even if execution is parallel
    await runParallelBounded(
      [
        async (c) => {
          await withSpan(tracer, "verify.signatures", signatureStage)(c);
        },
        async (c) => {
          await withSpan(tracer, "risk.score", riskScoreStage())(c);
        },
      ],
      ctx,
      limiter,
    );
  };

  const sagaStage: Stage = async (ctx) => {
    await saga.run(ctx);
  };

  return async (ctx) => {
    await runSequential(
      [
        withSpan(tracer, "validate.core", validateBasics),
        withSpan(tracer, "prechecks.parallel", parallelChecks),
        withSpan(tracer, "funds_and_ledger.saga", sagaStage),
      ],
      ctx,
    );
  };
}

export function buildDefaultPaymentPipeline(tracer: Tracer): Stage {
  return buildPipelineWithVerifier(
    tracer,
    withRetryStage(defaultRetryPolicy, createSignatureVerifier()),
    undefined,
  );
}

/**
 * Hardened path for Rail server: optional offline token store enables nfc|ble|qr with server-issued spend envelopes.
 */
export function buildHardenedPaymentPipeline(tracer: Tracer, tokenStore?: IOfflineTokenStore): Stage {
  return buildPipelineWithVerifier(tracer, createStableSignatureVerifier(), tokenStore);
}
