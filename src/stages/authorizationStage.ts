

import { Pool } from "pg";
import { createHmac } from "node:crypto";

let pool: Pool | undefined;

export function initWalletPool(p: Pool) {
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


export function createAuthorization(input: {
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

  const payload = [
    input.txId,
    input.senderWalletId,
    input.receiverWalletId,
    String(input.amountMinor),
    input.currency,
  ].join("|");

  const signature = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payload)
    .digest("base64");

  return {
    ...input,
    signature,
  };
}