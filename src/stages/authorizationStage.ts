import { randomBytes } from "node:crypto";
<<<<<<< HEAD
import type { PaymentAuthorization } from "../domain/authorization.js";
import { signAuthorization } from "../crypto/authorizationSigning.js";

/**
 * Input required to create authorization
 */
=======
import type { Pool } from "pg";
import { PostgresWalletStore } from "../persistence/postgresWalletStore.js";
import { signAuthorization } from "../crypto/authorizationSigning.js";

let walletStore: PostgresWalletStore;

export function initAuthorizationWallet(pool: Pool) {
  walletStore = new PostgresWalletStore(pool);
}

>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
export interface CreateAuthorizationInput {
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
}

<<<<<<< HEAD
/**
 * Create a signed authorization
 */
export function createAuthorization(
  input: CreateAuthorizationInput
): PaymentAuthorization {
=======
export interface PaymentAuthorization {
  authId: string;
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  signature: string;
}

export async function createAuthorization(input: CreateAuthorizationInput): Promise<PaymentAuthorization> {
>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";

  if (!secret) {
    throw new Error("RAIL_SIGNING_SECRET is required");
  }

<<<<<<< HEAD
=======
  if (!walletStore) {
    throw new Error("wallet_store_not_initialized");
  }

>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
  if (input.amountMinor <= 0) {
    throw new Error("invalid_amount");
  }

  if (input.senderWalletId === input.receiverWalletId) {
    throw new Error("self_transfer_not_allowed");
  }

<<<<<<< HEAD
=======
  // 💰 REAL reservation (DB atomic)
  await walletStore.reserve(input.senderWalletId, input.amountMinor);

>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
  const now = Date.now();

  const authBase = {
    authId: `auth_${randomBytes(8).toString("hex")}`,
    txId: input.txId,
    senderWalletId: input.senderWalletId,
    receiverWalletId: input.receiverWalletId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    createdAt: new Date(now).toISOString(),
<<<<<<< HEAD
    expiresAt: new Date(now + 30 * 1000).toISOString(), // 30 sec expiry
=======
    expiresAt: new Date(now + 30 * 1000).toISOString(),
>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
  };

  const signature = signAuthorization(authBase, secret);

  return {
    ...authBase,
    signature,
  };
<<<<<<< HEAD
}
=======
}

// Lifecycle functions now DB-backed

export async function consumeReservation(walletId: string, amount: number) {
  if (!walletStore) throw new Error("wallet_store_not_initialized");
  await walletStore.consume(walletId, amount);
}

export async function releaseReservation(walletId: string, amount: number) {
  if (!walletStore) throw new Error("wallet_store_not_initialized");
  await walletStore.release(walletId, amount);
}
>>>>>>> 08f9480 (feat: integrate postgres wallet with reservation lifecycle and pipeline execution)
