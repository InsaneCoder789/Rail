import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { PaymentAuthorization, StoredPaymentAuthorization } from "../domain/authorization.js";
import type { PaymentTransaction } from "../domain/types.js";
import { PipelineError } from "../pipeline/errors.js";
import { signAuthorization } from "../crypto/authorizationSigning.js";

const DEFAULT_AUTH_TTL_MS = 5 * 60 * 1000;
function validateMoney(amount: number, currency: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1e12 || !/^[A-Z]{3}$/.test(currency)) {
    throw new PipelineError("INVALID_TRANSACTION", "INVALID_TRANSACTION");
  }
}

// 🔒 Reserve money (authorization step)
export async function reserveFunds(client: PoolClient, walletId: string, amount: number, currency: string): Promise<void> {
  validateMoney(amount, currency);
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
export async function consumeReservation(client: PoolClient, walletId: string, amount: number, currency: string): Promise<void> {
  validateMoney(amount, currency);
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
export async function releaseReservation(client: PoolClient, walletId: string, amount: number, currency: string): Promise<void> {
  validateMoney(amount, currency);
  const res = await client.query(
    `UPDATE wallets
     SET balance = balance + $2,
         reserved = reserved - $2
     WHERE wallet_id = $1 AND currency = $3 AND reserved >= $2`,
    [walletId, amount, currency]
  );
  if (res.rowCount === 0) {
    throw new Error("RESERVATION_WALLET_NOT_FOUND");
  }
}

// 💰 Credit the receiver's wallet
export async function creditWallet(client: PoolClient, walletId: string, amount: number, currency: string): Promise<void> {
  validateMoney(amount, currency);
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

export async function getAuthorizationById(authId: string, db: Pool): Promise<StoredPaymentAuthorization | undefined> {
  return authorizationTransaction(db, async client => {
    await expireReservations(client, 1, undefined, authId);
    const result = await client.query("SELECT * FROM authorizations WHERE auth_id = $1", [authId]);
    return result.rows.length ? mapStoredAuthorization(result.rows[0]) : undefined;
  });
}

export async function claimAuthorizationForExecution(
  client: PoolClient,
  authId: string,
  txn: PaymentTransaction,
): Promise<void> {
  const res = await client.query(
    `UPDATE authorizations
     SET status = 'used',
         used_at = NOW()
     WHERE auth_id = $1
       AND tx_id = $2
       AND sender_wallet_id = $3
       AND receiver_wallet_id = $4
       AND amount_minor = $5
       AND currency = $6
       AND status = 'issued'
       AND expires_at > clock_timestamp()`,
    [authId, txn.txId, txn.senderWalletId, txn.receiverWalletId, txn.amountMinor, txn.currency],
  );

  if (res.rowCount === 0) {
    throw new PipelineError("AUTH_NOT_EXECUTABLE", "AUTH_NOT_EXECUTABLE");
  }
}

/** Legacy replay migration requires both a used authorization and its balanced ledger pair. */
export async function verifyCommittedAuthorization(client: PoolClient, txn: PaymentTransaction): Promise<void> {
  const authorization = await client.query(
    `SELECT a.auth_id FROM authorizations a
     JOIN authorization_usage u ON u.auth_id = a.auth_id AND u.tx_id = a.tx_id
     WHERE a.auth_id = $1 AND a.tx_id = $2 AND a.sender_wallet_id = $3
       AND a.receiver_wallet_id = $4 AND a.amount_minor = $5 AND a.currency = $6 AND a.status = 'used'`,
    [txn.authorizationId, txn.txId, txn.senderWalletId, txn.receiverWalletId, txn.amountMinor, txn.currency]);
  const ledger = await client.query(
    "SELECT wallet_id, entry_type, amount_minor, currency FROM ledger_entries WHERE tx_id = $1", [txn.txId]);
  const matches = (type: string, wallet: string) => ledger.rows.some((row) => row.entry_type === type &&
    row.wallet_id === wallet && Number(row.amount_minor) === txn.amountMinor && row.currency === txn.currency);
  if (authorization.rowCount !== 1 || ledger.rowCount !== 2 || !matches("debit", txn.senderWalletId) || !matches("credit", txn.receiverWalletId)) {
    throw new PipelineError("COMMITTED_PAYMENT_MISMATCH", "COMMITTED_PAYMENT_MISMATCH");
  }
}

async function authorizationTransaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let discard = false;
  const onError = () => { discard = true; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
    client.removeListener("error", onError);
  }
}

async function expireReservations(client: PoolClient, limit: number, walletId?: string, authId?: string): Promise<number> {
  const expired = await client.query(
    `SELECT auth_id, sender_wallet_id, amount_minor, currency FROM authorizations
     WHERE status = 'issued' AND expires_at <= clock_timestamp()
       AND ($2::text IS NULL OR sender_wallet_id = $2)
       AND ($3::text IS NULL OR auth_id = $3)
     ORDER BY expires_at ASC, auth_id ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit, walletId ?? null, authId ?? null],
  );
  // Match payment execution's wallet lock order to avoid opposing-transfer deadlocks.
  const wallets = [...new Set(expired.rows.map(row => String(row.sender_wallet_id)))].sort();
  if (wallets.length) {
    await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) ORDER BY wallet_id FOR UPDATE", [wallets]);
  }
  for (const row of expired.rows as Record<string, unknown>[]) {
    await releaseReservation(client, String(row.sender_wallet_id), Number(row.amount_minor), String(row.currency));
    await client.query("UPDATE authorizations SET status = 'expired', released_at = NOW() WHERE auth_id = $1", [String(row.auth_id)]);
  }
  return expired.rowCount ?? 0;
}

export async function releaseExpiredAuthorizations(db: Pool, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid_sweep_limit");
  return authorizationTransaction(db, client => expireReservations(client, limit));
}

export async function createAuthorization(input: {
  txId: string;
  senderWalletId: string;
  receiverWalletId: string;
  amountMinor: number;
  currency: string;
  ttlMs?: number;
}, db: Pool): Promise<PaymentAuthorization> {
  validateMoney(input.amountMinor, input.currency);
  for (const [id, minimum] of [[input.txId, 8], [input.senderWalletId, 3], [input.receiverWalletId, 3]] as const) {
    if (typeof id !== "string" || id.length < minimum || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) {
      throw new PipelineError("INVALID_TRANSACTION", "INVALID_TRANSACTION");
    }
  }
  if (input.senderWalletId === input.receiverWalletId) throw new PipelineError("SELF_TRANSFER", "SELF_TRANSFER");
  const ttlMs = input.ttlMs ?? DEFAULT_AUTH_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 60 * 1000) throw new PipelineError("INVALID_TRANSACTION", "INVALID_TRANSACTION");
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";

  if (!secret) {
    throw new Error("missing signing secret");
  }

  return authorizationTransaction(db, async client => {
    // Serialize issuance even when the authorization row does not exist yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`authorize:${input.txId}`]);
    let existing = await client.query(
      `SELECT auth_id, tx_id, sender_wallet_id, receiver_wallet_id, amount_minor,
              currency, status, signature, created_at, expires_at, used_at, released_at
       FROM authorizations
       WHERE tx_id = $1
       FOR UPDATE`,
      [input.txId],
    );
    await expireReservations(client, 1000, input.senderWalletId);
    if (existing.rowCount && existing.rowCount > 0) {
      existing = await client.query("SELECT * FROM authorizations WHERE tx_id = $1", [input.txId]);
      const current = mapStoredAuthorization(existing.rows[0] as Record<string, unknown>);
      if (
        current.senderWalletId !== input.senderWalletId ||
        current.receiverWalletId !== input.receiverWalletId ||
        current.amountMinor !== input.amountMinor ||
        current.currency !== input.currency
      ) {
        throw new PipelineError("AUTHORIZATION_TX_CONFLICT", "AUTHORIZATION_TX_CONFLICT");
      }
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
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
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

    return auth;
  });
}
