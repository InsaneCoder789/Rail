import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { PaymentAuthorization, StoredPaymentAuthorization } from "../domain/authorization.js";
import { signAuthorization } from "../crypto/authorizationSigning.js";

let pool: Pool | undefined;
const DEFAULT_AUTH_TTL_MS = 5 * 60 * 1000;

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
export async function reserveFunds(client: any, walletId: string, amount: number, currency: string): Promise<void> {
  const res = await client.query(
    `UPDATE wallets
     SET balance = balance - $2,
         reserved = reserved + $2
     WHERE wallet_id = $1 AND currency = $3 AND balance >= $2`,
    [walletId, amount, currency]
  );

  if (res.rowCount === 0) {
    throw new Error("INSUFFICIENT_FUNDS");
  }
}

// 💸 Consume reserved money (final debit)
export async function consumeReservation(client: any, walletId: string, amount: number, currency: string): Promise<void> {
  const res = await client.query(
    `UPDATE wallets
     SET reserved = reserved - $2
     WHERE wallet_id = $1 AND currency = $3 AND reserved >= $2`,
    [walletId, amount, currency]
  );

  if (res.rowCount === 0) {
    throw new Error("INVALID_RESERVATION");
  }
}

// 🔄 Release reserved money (rollback case)
export async function releaseReservation(client: any, walletId: string, amount: number, currency: string): Promise<void> {
  await client.query(
    `UPDATE wallets
     SET balance = balance + $2,
         reserved = reserved - $2
     WHERE wallet_id = $1 AND currency = $3`,
    [walletId, amount, currency]
  );
}

// 💰 Credit the receiver's wallet
export async function creditWallet(client: any, walletId: string, amount: number, currency: string): Promise<void> {
  const res = await client.query(
    `UPDATE wallets
     SET balance = balance + $2
     WHERE wallet_id = $1 AND currency = $3`,
    [walletId, amount, currency]
  );

  if (res.rowCount === 0) {
    throw new Error("WALLET_NOT_FOUND");
  }
}

function mapStoredAuthorization(row: Record<string, unknown>): StoredPaymentAuthorization {
  return {
    authId: String(row.auth_id),
    txId: String(row.tx_id),
    senderWalletId: String(row.sender_wallet_id),
    receiverWalletId: String(row.receiver_wallet_id),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    signature: String(row.signature),
    status: String(row.status) as StoredPaymentAuthorization["status"],
    usedAt: row.used_at ? new Date(String(row.used_at)).toISOString() : undefined,
    releasedAt: row.released_at ? new Date(String(row.released_at)).toISOString() : undefined,
  };
}

export async function getAuthorizationById(authId: string): Promise<StoredPaymentAuthorization | undefined> {
  const db = requirePool();
  const res = await db.query(
    `SELECT
       auth_id,
       tx_id,
       sender_wallet_id,
       receiver_wallet_id,
       amount_minor,
       currency,
       status,
       signature,
       created_at,
       expires_at,
       used_at,
       released_at
     FROM authorizations
     WHERE auth_id = $1`,
    [authId],
  );

  if (res.rowCount === 0) {
    return undefined;
  }

  return mapStoredAuthorization(res.rows[0] as Record<string, unknown>);
}

export async function claimAuthorizationForExecution(
  client: PoolClient,
  authId: string,
  txId: string,
): Promise<void> {
  const res = await client.query(
    `UPDATE authorizations
     SET status = 'used',
         used_at = NOW()
     WHERE auth_id = $1
       AND tx_id = $2
       AND status = 'issued'
       AND expires_at > NOW()`,
    [authId, txId],
  );

  if (res.rowCount === 0) {
    throw new Error("AUTH_NOT_EXECUTABLE");
  }
}

export async function releaseExpiredAuthorizations(limit = 100): Promise<number> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const expired = await client.query(
      `SELECT auth_id, sender_wallet_id, amount_minor, currency
       FROM authorizations
       WHERE status = 'issued'
         AND expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    for (const row of expired.rows as Record<string, unknown>[]) {
      await releaseReservation(
        client,
        String(row.sender_wallet_id),
        Number(row.amount_minor),
        String(row.currency),
      );

      await client.query(
        `UPDATE authorizations
         SET status = 'expired',
             released_at = NOW()
         WHERE auth_id = $1`,
        [String(row.auth_id)],
      );
    }

    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createAuthorization(input: {
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
  ttlMs?: number;
}): Promise<PaymentAuthorization> {
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";

  if (!secret) {
    throw new Error("missing signing secret");
  }

  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT auth_id, tx_id, sender_wallet_id, receiver_wallet_id, amount_minor,
              currency, status, signature, created_at, expires_at, used_at, released_at
       FROM authorizations
       WHERE tx_id = $1
       FOR UPDATE`,
      [input.txId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const current = mapStoredAuthorization(existing.rows[0] as Record<string, unknown>);
      if (
        current.senderWalletId !== input.senderWalletId ||
        current.receiverWalletId !== input.receiverWalletId ||
        current.amountMinor !== input.amountMinor ||
        current.currency !== input.currency
      ) {
        throw new Error("AUTHORIZATION_TX_CONFLICT");
      }
      await client.query("COMMIT");
      return current;
    }

    await reserveFunds(client, input.senderWalletId, input.amountMinor, input.currency);

    const unsignedAuth = {
      authId: `auth_${randomUUID()}`,
      txId: input.txId,
      senderWalletId: input.senderWalletId,
      receiverWalletId: input.receiverWalletId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_AUTH_TTL_MS)).toISOString(),
    } as const;

    const signature = signAuthorization(unsignedAuth, secret);
    const auth: PaymentAuthorization = {
      ...unsignedAuth,
      signature,
    };

    await client.query(
      `INSERT INTO authorizations (
         auth_id,
         tx_id,
         sender_wallet_id,
         receiver_wallet_id,
         amount_minor,
         currency,
         status,
         signature,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7, $8::timestamptz, $9::timestamptz)`,
      [
        auth.authId,
        auth.txId,
        auth.senderWalletId,
        auth.receiverWalletId,
        auth.amountMinor,
        auth.currency,
        auth.signature,
        auth.createdAt,
        auth.expiresAt,
      ],
    );

    await client.query("COMMIT");
    return auth;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
