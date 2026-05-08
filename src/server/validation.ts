import type { PaymentTransaction } from "../domain/types.js";

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_AMOUNT_MINOR = 1_000_000_000_000;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const OFFLINE_CHANNELS = new Set<PaymentTransaction["channel"]>(["nfc", "ble", "qr"]);

export function isSafeText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length < min || value.length > max) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  return true;
}

export function isCurrency(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_RE.test(value);
}

export function isValidAmountMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_MINOR;
}

export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function isValidChannel(value: unknown): value is PaymentTransaction["channel"] {
  return value === "nfc" || value === "ble" || value === "qr" || value === "online";
}

export function isOptionalBase64(value: unknown, maxLength: number): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.length < 16 || value.length > maxLength) return false;
  return BASE64_RE.test(value);
}

export function isPaymentTransaction(x: unknown): x is PaymentTransaction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (!isSafeText(o.txId, 8, 128)) return false;
  if (!isSafeText(o.idempotencyKey, 8, 128)) return false;
  if (o.authorizationId !== undefined && !isSafeText(o.authorizationId, 8, 128)) return false;
  if (!isSafeText(o.senderWalletId, 3, 128)) return false;
  if (!isSafeText(o.receiverWalletId, 3, 128)) return false;
  if (!isValidAmountMinor(o.amountMinor)) return false;
  if (!isCurrency(o.currency)) return false;
  if (!isValidChannel(o.channel)) return false;
  if (!isValidIsoTimestamp(o.createdAt)) return false;
  if (o.deviceId !== undefined && !isSafeText(o.deviceId, 3, 128)) return false;
  if (o.offlineTokenId !== undefined && !isSafeText(o.offlineTokenId, 8, 128)) return false;
  if (!isOptionalBase64(o.paymentSignature, 4096)) return false;

  if (OFFLINE_CHANNELS.has(o.channel)) {
    if (!isSafeText(o.offlineTokenId, 8, 128)) return false;
    if (!isSafeText(o.deviceId, 3, 128)) return false;
    return true;
  }

  if (o.offlineTokenId !== undefined) {
    return false;
  }

  return true;
}

export function toPaymentTransaction(parsed: PaymentTransaction): PaymentTransaction {
  return {
    ...parsed,
    authorizationId: typeof parsed.authorizationId === "string" ? parsed.authorizationId : undefined,
    offlineTokenId:
      parsed.channel === "online" ? undefined : typeof parsed.offlineTokenId === "string" ? parsed.offlineTokenId : undefined,
    deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
    paymentSignature: typeof parsed.paymentSignature === "string" ? parsed.paymentSignature : undefined,
  };
}

export function isIssueTokenRequest(x: unknown): x is {
  walletId: string;
  deviceId: string;
  amountCapMinor: number;
  currency?: string;
  ttlSeconds?: number;
} {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    isSafeText(o.walletId, 3, 128) &&
    isSafeText(o.deviceId, 3, 128) &&
    isValidAmountMinor(o.amountCapMinor) &&
    (o.currency === undefined || isCurrency(o.currency)) &&
    (o.ttlSeconds === undefined ||
      (typeof o.ttlSeconds === "number" &&
        Number.isSafeInteger(o.ttlSeconds) &&
        o.ttlSeconds >= MIN_TTL_SECONDS &&
        o.ttlSeconds <= MAX_TTL_SECONDS))
  );
}

export function isSyncBody(x: unknown, maxSyncBatchSize: number): x is { deviceId: string; transactions: unknown[] } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    isSafeText(o.deviceId, 3, 128) &&
    Array.isArray(o.transactions) &&
    o.transactions.length > 0 &&
    o.transactions.length <= maxSyncBatchSize
  );
}
