import { createHash } from "node:crypto";
import { parseProviderPaymentBinding, providerBudgetDisposition, providerPaymentConsentFingerprint,
  providerPaymentFingerprint, type ProviderPayment } from "./providerPayment.js";

export interface ProviderOutcomeReceipt {
  readonly version: 1;
  readonly assurance: "local_simulator_outcome";
  readonly operationId: string;
  readonly ownerWalletId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly sharedBudgetId: string;
  readonly intentId: string;
  readonly paymentFingerprint: string;
  readonly consentFingerprint: string;
  readonly consentChallengeId: string;
  readonly merchantWalletId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly allowanceDisposition: "spent" | "released";
  readonly providerRef: string | null;
  readonly submissionStartedAt: string | null;
  readonly outcomeRecordedAt: string;
  readonly journalRevision: number;
}

/** Trusted journal input only. This contract cannot attest a real provider or settlement. */
export function createProviderOutcomeReceipt(payment: ProviderPayment & { readonly revision: number }, consent: {
  readonly merchantWalletId: string; readonly consentFingerprint: string; readonly challengeId: string;
}): ProviderOutcomeReceipt {
  const binding = parseProviderPaymentBinding(payment.binding);
  const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  if (binding.provider !== "simulator" || payment.fingerprint !== providerPaymentFingerprint(binding) ||
      payment.idempotencyKey !== `rail_provider_v1_${binding.operationId}` ||
      consent.consentFingerprint !== providerPaymentConsentFingerprint(binding, consent.merchantWalletId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(consent.challengeId) ||
      !Number.isSafeInteger(payment.revision) || payment.revision < 2 || !timestamp(payment.updatedAtMs) ||
      !["succeeded", "failed", "cancelled"].includes(payment.status)) throw new Error("INVALID_PROVIDER_OUTCOME_RECEIPT");
  if (payment.firstSubmissionAtMs === null) {
    if (payment.status !== "cancelled" || payment.providerRef !== null) throw new Error("INVALID_PROVIDER_OUTCOME_RECEIPT");
  } else if (!timestamp(payment.firstSubmissionAtMs) || payment.firstSubmissionAtMs > payment.updatedAtMs ||
      typeof payment.providerRef !== "string" || !/^[A-Za-z0-9_.:-]{3,128}$/.test(payment.providerRef)) {
    throw new Error("INVALID_PROVIDER_OUTCOME_RECEIPT");
  }
  return Object.freeze({ version: 1, assurance: "local_simulator_outcome", operationId: binding.operationId,
    ownerWalletId: binding.ownerWalletId, agentId: binding.agentId, mandateId: binding.mandateId,
    sharedBudgetId: binding.sharedBudgetId, intentId: binding.intentId, paymentFingerprint: payment.fingerprint,
    consentFingerprint: consent.consentFingerprint, consentChallengeId: consent.challengeId,
    merchantWalletId: consent.merchantWalletId, amountMinor: binding.amountMinor, currency: binding.currency,
    status: payment.status as ProviderOutcomeReceipt["status"],
    allowanceDisposition: providerBudgetDisposition(payment.status) as "spent" | "released",
    providerRef: payment.providerRef,
    submissionStartedAt: payment.firstSubmissionAtMs === null ? null : new Date(payment.firstSubmissionAtMs).toISOString(),
    outcomeRecordedAt: new Date(payment.updatedAtMs).toISOString(), journalRevision: payment.revision });
}

/** The caller supplies the original trusted operation fingerprint, not envelope metadata. */
export function providerOutcomeReceiptBinding(operationId: string, paymentFingerprint: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) ||
      !/^[a-f0-9]{64}$/.test(paymentFingerprint)) throw new Error("INVALID_PROVIDER_OUTCOME_BINDING");
  return { txId: operationId, requestFingerprint: createHash("sha256").update(JSON.stringify(
    ["rail:provider-outcome:v1", operationId, paymentFingerprint])).digest("hex") };
}
