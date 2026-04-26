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
import { consumeReservation, releaseReservation, creditWallet } from "./authorizationStage.js";
import { Pool } from "pg";

let ledgerPool: Pool | null = null;

export function initLedger(pool: Pool) {
  ledgerPool = pool;
}

async function recordLedgerEntry(
  type: "debit" | "credit",
  walletId: string,
  amount: number,
  txId: string
) {
  if (!ledgerPool) {
    throw new Error("ledger_not_initialized");
  }

  await ledgerPool.query(
    `INSERT INTO ledger_entries (tx_id, wallet_id, entry_type, amount_minor)
     VALUES ($1, $2, $3, $4)`,
    [txId, walletId, type, amount]
  );
}

const WALLET_RESERVE_KEY = "wallet.reserveId";

function validateBasics(ctx: PaymentContext): Promise<void> {
  const { txn } = ctx;
  if (!Number.isSafeInteger(txn.amountMinor) || txn.amountMinor <= 0) {
    return Promise.reject(new PipelineError("invalid_amount", "INVALID_AMOUNT", false));
  }
  if (!/^[A-Z]{3}$/.test(txn.currency)) {
    return Promise.reject(new PipelineError("invalid_currency", "INVALID_CURRENCY", false));
  }
  if (txn.senderWalletId === txn.receiverWalletId) {
    return Promise.reject(new PipelineError("self_transfer", "SELF_TRANSFER", false));
  }
  if ((txn.channel === "nfc" || txn.channel === "ble" || txn.channel === "qr") && !txn.offlineTokenId) {
    return Promise.reject(new PipelineError("offline_token_required", "OFFLINE_TOKEN", false));
  }
  if ((txn.channel === "nfc" || txn.channel === "ble" || txn.channel === "qr") && !txn.deviceId) {
    return Promise.reject(new PipelineError("offline_device_required", "OFFLINE_DEVICE", false));
  }
  if (txn.channel === "online" && txn.offlineTokenId) {
    return Promise.reject(new PipelineError("offline_token_not_allowed_for_online", "OFFLINE_TOKEN_FOR_ONLINE", false));
  }
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
    const velocity = Math.abs(ctx.txn.txId.charCodeAt(0) % 5);
    const score = 82 - velocity * 3;
    const decision = score >= 75 ? "allow" : score >= 60 ? "challenge" : "block";
    ctx.risk = {
      score,
      decision,
      reasons: [`velocity_hint=${velocity}`],
    };
    if (decision === "block") {
      throw new PipelineError("risk_blocked", "RISK_BLOCK", false);
    }
  };
}

function walletSaga(tokenStore?: IOfflineTokenStore): SagaCoordinator {
  const steps: SagaStep[] = [
    ...(tokenStore
      ? [
          {
            name: "offline.token_reserve",
            forward: async (ctx) => {
              const gate = await tokenStore.beginOfflineSpend(ctx.txn);
              if (!gate.ok) {
                throw new PipelineError(gate.reason, gate.reason, false);
              }
            },
            compensate: async (ctx) => {
              await tokenStore.rollbackOfflineSpend(ctx.txn);
            },
          } satisfies SagaStep,
        ]
      : []),
    {
      name: "wallet.transfer",
      forward: async (ctx) => {
        // 1. Debit sender (consume reserved funds)
        await consumeReservation(
          ctx.txn.senderWalletId,
          ctx.txn.amountMinor
        );

        // 2. Credit receiver
        await creditWallet(
          ctx.txn.receiverWalletId,
          ctx.txn.amountMinor
        );
      },
      compensate: async (ctx) => {
        // Rollback: give money back to sender
        await releaseReservation(
          ctx.txn.senderWalletId,
          ctx.txn.amountMinor
        );

        // NOTE: In production, you'd also reverse receiver credit via ledger reversal
      },
    },
    {
      name: "ledger.post",
      forward: async (ctx) => {
        if (ctx.risk?.decision === "challenge") {
          ctx.outbox.append({
            type: "payments.step_up_required",
            payload: { txId: ctx.txn.txId, correlationId: ctx.correlationId },
          });
        }

        // 🔥 PERSISTENT DOUBLE ENTRY LEDGER
        await recordLedgerEntry(
          "debit",
          ctx.txn.senderWalletId,
          ctx.txn.amountMinor,
          ctx.txn.txId
        );

        await recordLedgerEntry(
          "credit",
          ctx.txn.receiverWalletId,
          ctx.txn.amountMinor,
          ctx.txn.txId
        );

        // keep event system
        ctx.outbox.append({
          type: "payments.ledger_posted",
          payload: {
            txId: ctx.txn.txId,
            amountMinor: ctx.txn.amountMinor,
            channel: ctx.txn.channel,
            offline: ctx.txn.channel !== "online",
          },
        });

        if (tokenStore) {
          await tokenStore.finalizeOfflineSpend(ctx.txn);
        }

        ctx.result = {
          status: "accepted",
          ledgerEntryId: `leg_${ctx.txn.txId}`,
        };
      },
      compensate: async (ctx) => {
        ctx.outbox.append({
          type: "payments.ledger_reversed",
          payload: { txId: ctx.txn.txId },
        });
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
    await runParallelBounded(
      [withSpan(tracer, "verify.signatures", signatureStage), withSpan(tracer, "risk.score", riskScoreStage())],
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
