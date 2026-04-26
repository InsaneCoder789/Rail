import { randomBytes } from "node:crypto";
import type { PaymentAuthorization } from "../domain/authorization.js";
import { signAuthorization } from "../crypto/authorizationSigning.js";

/**
 * Input required to create authorization
 */
export interface CreateAuthorizationInput {
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
}

/**
 * Create a signed authorization
 */
export function createAuthorization(
  input: CreateAuthorizationInput
): PaymentAuthorization {
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";

  if (!secret) {
    throw new Error("RAIL_SIGNING_SECRET is required");
  }

  if (input.amountMinor <= 0) {
    throw new Error("invalid_amount");
  }

  if (input.senderWalletId === input.receiverWalletId) {
    throw new Error("self_transfer_not_allowed");
  }

  const now = Date.now();

  const authBase = {
    authId: `auth_${randomBytes(8).toString("hex")}`,
    txId: input.txId,
    senderWalletId: input.senderWalletId,
    receiverWalletId: input.receiverWalletId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 1000).toISOString(), // 30 sec expiry
  };

  const signature = signAuthorization(authBase, secret);

  return {
    ...authBase,
    signature,
  };
}