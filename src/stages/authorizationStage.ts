import { Pool } from "pg";
import { createHmac } from "node:crypto";

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let pool: Pool | undefined;

export function initAuthorizationWallet(p: Pool) {
  pool = p;
}

function requirePool(): Pool {
  if (!pool) {
    throw new Error("wallet pool not initialized");
  }
  return pool;
}

// 🔒 Reserve money (authorization step)
export async function reserveFunds(walletId: string, amount: number): Promise<void> {
  const db = requirePool();

  const res = await db.query(
    `UPDATE wallets
     SET balance = balance - $2,
         reserved = reserved + $2
     WHERE wallet_id = $1 AND balance >= $2`,
    [walletId, amount]
  );

  if (res.rowCount === 0) {
    throw new Error("INSUFFICIENT_FUNDS");
  }
}

// 💸 Consume reserved money (final debit)
export async function consumeReservation(walletId: string, amount: number): Promise<void> {
  const db = requirePool();

  await db.query("BEGIN");

  try {
    const res = await db.query(
      `UPDATE wallets
       SET reserved = reserved - $2
       WHERE wallet_id = $1 AND reserved >= $2`,
      [walletId, amount]
    );

    if (res.rowCount === 0) {
      throw new Error("INVALID_RESERVATION");
    }

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

// 🔄 Release reserved money (rollback case)
export async function releaseReservation(walletId: string, amount: number): Promise<void> {
  const db = requirePool();

  await db.query(
    `UPDATE wallets
     SET balance = balance + $2,
         reserved = reserved - $2
     WHERE wallet_id = $1`,
    [walletId, amount]
  );
}

// 💰 Credit the receiver's wallet
export async function creditWallet(walletId: string, amount: number): Promise<void> {
  const db = requirePool();

  const res = await db.query(
    `UPDATE wallets
     SET balance = balance + $2
     WHERE wallet_id = $1`,
    [walletId, amount]
  );

  if (res.rowCount === 0) {
    throw new Error("WALLET_NOT_FOUND");
  }
}


export async function createAuthorization(input: {
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
}) {
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";

  if (!secret) {
    throw new Error("missing signing secret");
  }

  // 1) Reserve funds first (real money lock)
  await reserveFunds(input.senderWalletId, input.amountMinor);

  // 2) Build FULL authorization object (must match verifier exactly)
  const auth = {
    authId: `auth_${randomId()}`,
    txId: input.txId,
    senderWalletId: input.senderWalletId,
    receiverWalletId: input.receiverWalletId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
  } as const;

  // 3) Canonical payload MUST match verification order
  const payload = [
    auth.authId,
    auth.txId,
    auth.senderWalletId,
    auth.receiverWalletId,
    String(auth.amountMinor),
    auth.currency,
    auth.createdAt,
    auth.expiresAt,
  ].join("|");

  const signature = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payload)
    .digest("base64");

  // 4) Return full object (ALL fields are required for verification)
  return {
    ...auth,
    signature,
  };
}