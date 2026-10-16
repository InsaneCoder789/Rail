import { createHash } from "node:crypto";

export interface ProviderPaymentBinding {
  readonly version: 1;
  readonly operationId: string;
  readonly ownerWalletId: string;
  readonly agentId: string;
  readonly intentId: string;
  readonly mandateId: string;
  readonly sharedBudgetId: string;
  readonly provider: string;
  readonly providerAccountRef: string;
  readonly merchantRef: string;
  readonly instrumentRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly requestFingerprint: string;
  readonly authorizationExpiresAt: string;
}

export type ProviderPaymentStatus = "reserved" | "submitting" | "unknown" | "processing" | "requires_owner_action" |
  "succeeded" | "failed" | "cancelled";

export interface ProviderPayment {
  readonly binding: ProviderPaymentBinding;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly status: ProviderPaymentStatus;
  readonly providerRef: string | null;
  readonly firstSubmissionAtMs: number | null;
  readonly retryWindowEndsAtMs: number | null;
  readonly updatedAtMs: number;
}

/** Normalize only after authenticated callback/retrieval and actual provider-field checks. */
export interface ProviderObservation {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly provider: string;
  readonly providerAccountRef: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: "processing" | "requires_owner_action" | "succeeded" | "failed" | "cancelled";
  /** A recoverable decline or requires_payment_method must not be normalized as final failure. */
  readonly final: boolean;
}

export type ProviderPaymentEvent = { readonly type: "begin_submission"; readonly idempotencyWindowMs: number } |
  { readonly type: "retry_submission" } | { readonly type: "submission_uncertain" } |
  { readonly type: "cancel_before_submission" } | { readonly type: "provider_observed"; readonly observation: ProviderObservation };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["version", "operationId", "ownerWalletId", "agentId", "intentId", "mandateId", "sharedBudgetId", "provider",
  "providerAccountRef", "merchantRef", "instrumentRef", "amountMinor", "currency", "requestFingerprint", "authorizationExpiresAt"] as const;
const terminal = (value: ProviderPaymentStatus) => value === "succeeded" || value === "failed" || value === "cancelled";
const reference = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{3,128}$/.test(value);
const time = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
function invalid(): never { throw new Error("INVALID_PROVIDER_PAYMENT_BINDING"); }

export function parseProviderPaymentBinding(value: unknown): ProviderPaymentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== FIELDS.length || !FIELDS.every(field => Object.hasOwn(row, field)) || row.version !== 1 ||
      ![row.operationId, row.agentId, row.intentId, row.mandateId, row.sharedBudgetId].every(id => typeof id === "string" && UUID.test(id)) ||
      ![row.ownerWalletId, row.providerAccountRef, row.merchantRef, row.instrumentRef].every(reference) ||
      typeof row.provider !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(row.provider) ||
      typeof row.amountMinor !== "number" || !Number.isSafeInteger(row.amountMinor) || row.amountMinor < 1 || row.amountMinor > 1e12 ||
      typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) ||
      typeof row.requestFingerprint !== "string" || !HASH.test(row.requestFingerprint) ||
      typeof row.authorizationExpiresAt !== "string" || !Number.isFinite(Date.parse(row.authorizationExpiresAt)) ||
      new Date(row.authorizationExpiresAt).toISOString() !== row.authorizationExpiresAt) invalid();
  return Object.freeze(Object.fromEntries(FIELDS.map(field => [field, row[field]]))) as unknown as ProviderPaymentBinding;
}

export function providerPaymentFingerprint(value: ProviderPaymentBinding): string {
  const binding = parseProviderPaymentBinding(value);
  return createHash("sha256").update(JSON.stringify(["rail:provider-payment:v1", ...FIELDS.map(field => binding[field])])).digest("hex");
}

export function createProviderPayment(value: ProviderPaymentBinding, nowMs: number): ProviderPayment {
  const binding = parseProviderPaymentBinding(value);
  if (!time(nowMs) || Date.parse(binding.authorizationExpiresAt) <= nowMs) throw new Error("PROVIDER_AUTHORIZATION_EXPIRED");
  return Object.freeze({ binding, fingerprint: providerPaymentFingerprint(binding),
    idempotencyKey: `rail_provider_v1_${binding.operationId}`, status: "reserved", providerRef: null,
    firstSubmissionAtMs: null, retryWindowEndsAtMs: null, updatedAtMs: nowMs });
}

/** Pure lifecycle rules, not authentication, durable leasing or a provider adapter. */
export function advanceProviderPayment(payment: ProviderPayment, event: ProviderPaymentEvent, nowMs: number): ProviderPayment {
  if (!time(nowMs) || nowMs < payment.updatedAtMs) throw new Error("INVALID_PROVIDER_EVENT_TIME");
  const update = (fields: Partial<ProviderPayment>) => Object.freeze({ ...payment, ...fields, updatedAtMs: nowMs });
  switch (event.type) {
    case "begin_submission":
      if (payment.status !== "reserved" || payment.firstSubmissionAtMs !== null) throw new Error("INVALID_PROVIDER_TRANSITION");
      if (Date.parse(payment.binding.authorizationExpiresAt) <= nowMs) throw new Error("PROVIDER_AUTHORIZATION_EXPIRED");
      if (!Number.isSafeInteger(event.idempotencyWindowMs) || event.idempotencyWindowMs < 1 ||
          event.idempotencyWindowMs > 30 * 86400000 || !time(nowMs + event.idempotencyWindowMs)) throw new Error("INVALID_PROVIDER_RETRY_WINDOW");
      return update({ status: "submitting", firstSubmissionAtMs: nowMs, retryWindowEndsAtMs: nowMs + event.idempotencyWindowMs });
    case "retry_submission":
      if (payment.status !== "unknown" || payment.retryWindowEndsAtMs === null || nowMs >= payment.retryWindowEndsAtMs)
        throw new Error("PROVIDER_RETRY_NOT_PERMITTED");
      if (Date.parse(payment.binding.authorizationExpiresAt) <= nowMs) throw new Error("PROVIDER_AUTHORIZATION_EXPIRED");
      return update({ status: "submitting" });
    case "submission_uncertain":
      if (payment.status === "unknown") return payment;
      if (payment.status !== "submitting") throw new Error("INVALID_PROVIDER_TRANSITION");
      return update({ status: "unknown" });
    case "cancel_before_submission":
      if (payment.status === "cancelled" && payment.firstSubmissionAtMs === null) return payment;
      if (payment.status !== "reserved") throw new Error("PROVIDER_CANCELLATION_REQUIRES_CONFIRMATION");
      return update({ status: "cancelled" });
    case "provider_observed": {
      const observed = event.observation, expected = payment.binding;
      if (observed.operationId !== expected.operationId || observed.fingerprint !== payment.fingerprint || observed.provider !== expected.provider ||
          observed.providerAccountRef !== expected.providerAccountRef || observed.amountMinor !== expected.amountMinor || observed.currency !== expected.currency ||
          !reference(observed.providerRef) || (payment.providerRef !== null && payment.providerRef !== observed.providerRef)) throw new Error("PROVIDER_OBSERVATION_MISMATCH");
      if (!["processing", "requires_owner_action", "succeeded", "failed", "cancelled"].includes(observed.status) ||
          observed.final !== terminal(observed.status)) throw new Error("INVALID_PROVIDER_OBSERVATION");
      if (payment.firstSubmissionAtMs === null) throw new Error("PROVIDER_OBSERVATION_BEFORE_SUBMISSION");
      if (terminal(payment.status)) {
        if (!terminal(observed.status) || observed.status === payment.status) return payment;
        throw new Error("CONFLICTING_PROVIDER_OUTCOME");
      }
      // Financial resolution remains valid after owner revocation/deadline or a worker lease expires.
      return update({ status: observed.status, providerRef: observed.providerRef });
    }
    default: throw new Error("INVALID_PROVIDER_TRANSITION");
  }
}

export function providerBudgetDisposition(status: ProviderPaymentStatus): "held" | "spent" | "released" {
  switch (status) {
    case "reserved": case "submitting": case "unknown": case "processing": case "requires_owner_action": return "held";
    case "succeeded": return "spent";
    case "failed": case "cancelled": return "released";
    default: throw new Error("INVALID_PROVIDER_STATUS");
  }
}
