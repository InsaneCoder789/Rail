import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentAuthorization } from "../domain/authorization.js";

/**
 * Canonical string for signing authorization
 * MUST be identical on sign + verify
 */
export function canonicalAuthorizationPayload(auth: Omit<PaymentAuthorization, "signature">): string {
  return [
    auth.authId,
    auth.txId,
    auth.senderWalletId,
    auth.receiverWalletId,
    String(auth.amountMinor),
    auth.currency,
    auth.createdAt,
    auth.expiresAt,
  ].join("|");
}

/**
 * Server-side: create signature
 */
export function signAuthorization(
  auth: Omit<PaymentAuthorization, "signature">,
  secret: string
): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(canonicalAuthorizationPayload(auth))
    .digest("base64");
}

/**
 * Server-side: verify signature
 */
export function verifyAuthorization(
  auth: PaymentAuthorization,
  secret: string
): boolean {
  const { signature, ...unsigned } = auth;

  // ⏱️ Expiry validation
  try {
    const expiry = new Date(unsigned.expiresAt).getTime();
    if (!Number.isFinite(expiry) || Date.now() > expiry) {
      return false;
    }
  } catch {
    return false;
  }

  const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(canonicalAuthorizationPayload(unsigned))
    .digest();

  let actual: Buffer;

  try {
    actual = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}