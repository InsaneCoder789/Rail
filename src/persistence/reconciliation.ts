import type { Pool, PoolClient } from "pg";

export interface ReconciliationIssue {
  readonly type: "unbalanced_ledger" | "invalid_wallet_reservation" | "orphan_authorization_usage"
    | "missing_opening_balance" | "wallet_balance_mismatch" | "wallet_currency_mismatch"
    | "incomplete_payment" | "authorization_ledger_mismatch" | "scan_truncated";
  readonly txId?: string;
  readonly walletId?: string;
  readonly detail: string;
}

// One statement gives every comparison the same MVCC snapshot, even during live payments.
const CHECKS = `
WITH ledger AS (
  SELECT tx_id, COUNT(*) AS entries, COUNT(DISTINCT currency) AS currencies,
    COUNT(DISTINCT wallet_id) AS wallets, COUNT(DISTINCT entry_type) AS directions,
    SUM(CASE entry_type WHEN 'credit' THEN amount_minor ELSE -amount_minor END) AS imbalance
  FROM ledger_entries GROUP BY tx_id
), movements AS (
  SELECT wallet_id, SUM(CASE entry_type WHEN 'credit' THEN amount_minor ELSE -amount_minor END) AS movement
  FROM ledger_entries GROUP BY wallet_id
), reservations AS (
  SELECT sender_wallet_id AS wallet_id, SUM(amount_minor) AS reserved
  FROM authorizations WHERE status = 'issued' GROUP BY sender_wallet_id
), issues AS (
  SELECT 'unbalanced_ledger' AS type, tx_id, NULL::text AS wallet_id,
    'expected two entries, one currency and two wallets; imbalance=' || imbalance AS detail
  FROM ledger WHERE entries <> 2 OR currencies <> 1 OR wallets <> 2 OR directions <> 2 OR imbalance <> 0
  UNION ALL
  SELECT 'missing_opening_balance', NULL, wallet_id, 'opening balance requires an evidence-referenced operator review'
  FROM wallets WHERE opening_balance_minor IS NULL
  UNION ALL
  SELECT 'wallet_balance_mismatch', NULL, wallet.wallet_id,
    'available+reserved=' || COALESCE((wallet.balance::numeric + wallet.reserved)::text, 'missing') || '; opening+movements=' ||
    COALESCE((wallet.opening_balance_minor::numeric + COALESCE(movements.movement, 0))::text, 'unrecorded')
  FROM wallets wallet LEFT JOIN movements USING (wallet_id)
  WHERE (wallet.opening_balance_minor IS NOT NULL AND
    wallet.balance::numeric + wallet.reserved <> wallet.opening_balance_minor::numeric + COALESCE(movements.movement, 0))
     OR wallet.balance IS NULL OR wallet.reserved IS NULL OR wallet.balance < 0 OR wallet.reserved < 0 OR wallet.balance::numeric + wallet.reserved > 9007199254740991
  UNION ALL
  SELECT 'invalid_wallet_reservation', NULL, wallet.wallet_id,
    'reserved=' || COALESCE(wallet.reserved::text, 'missing') || '; issued authorizations=' || COALESCE(reservations.reserved, 0)
  FROM wallets wallet LEFT JOIN reservations USING (wallet_id)
  WHERE wallet.reserved IS NULL OR wallet.reserved <> COALESCE(reservations.reserved, 0)
  UNION ALL
  SELECT DISTINCT 'wallet_currency_mismatch', NULL, wallet.wallet_id, 'wallet and ledger currencies differ'
  FROM wallets wallet JOIN ledger_entries entry ON entry.wallet_id = wallet.wallet_id WHERE entry.currency <> wallet.currency
  UNION ALL
  SELECT 'wallet_currency_mismatch', NULL, wallet_id, 'wallet currency is not a three-letter code'
  FROM wallets WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$'
  UNION ALL
  SELECT 'orphan_authorization_usage', usage.tx_id, NULL, 'usage identity does not match a used authorization'
  FROM authorization_usage usage LEFT JOIN authorizations auth ON auth.auth_id = usage.auth_id AND auth.tx_id = usage.tx_id
  WHERE auth.auth_id IS NULL OR auth.status <> 'used'
  UNION ALL
  SELECT DISTINCT 'authorization_ledger_mismatch', entry.tx_id, NULL, 'ledger entry does not match its authorization'
  FROM ledger_entries entry LEFT JOIN authorizations auth ON auth.tx_id = entry.tx_id
  WHERE auth.auth_id IS NULL OR auth.status <> 'used' OR entry.amount_minor <> auth.amount_minor
    OR entry.currency <> auth.currency OR entry.wallet_id <>
      CASE entry.entry_type WHEN 'debit' THEN auth.sender_wallet_id ELSE auth.receiver_wallet_id END
  UNION ALL
  SELECT 'incomplete_payment', auth.tx_id, NULL, 'used authorization is missing matching ledger, usage, execution or replay state'
  FROM authorizations auth LEFT JOIN ledger ON ledger.tx_id = auth.tx_id
  LEFT JOIN authorization_usage usage ON usage.auth_id = auth.auth_id AND usage.tx_id = auth.tx_id
  LEFT JOIN rail_payment_executions execution ON execution.tx_id = auth.tx_id
  LEFT JOIN rail_idempotency replay ON replay.idempotency_key = execution.idempotency_key
  WHERE auth.status = 'used' AND (ledger.entries IS DISTINCT FROM 2::bigint OR ledger.imbalance IS DISTINCT FROM 0::numeric
    OR ledger.currencies IS DISTINCT FROM 1::bigint OR ledger.wallets IS DISTINCT FROM 2::bigint OR ledger.directions IS DISTINCT FROM 2::bigint
    OR usage.auth_id IS NULL OR execution.tx_id IS NULL OR replay.status IS DISTINCT FROM 'completed'
    OR replay.request_fingerprint IS DISTINCT FROM execution.request_fingerprint
    OR replay.result_json IS DISTINCT FROM execution.result_json)
)
SELECT type, tx_id AS "txId", wallet_id AS "walletId", detail FROM issues
WHERE ($2::text IS NULL OR wallet_id = $2 OR tx_id IN (
  SELECT tx_id FROM ledger_entries WHERE wallet_id = $2
  UNION SELECT tx_id FROM authorizations WHERE sender_wallet_id = $2 OR receiver_wallet_id = $2
)) AND (NOT $3::boolean OR type <> 'missing_opening_balance')
ORDER BY type, tx_id NULLS FIRST, wallet_id NULLS FIRST LIMIT $1`;

async function accountingTransaction<T>(pool: Pool, readOnly: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  const onError = () => { discard = true; };
  client.on("error", onError);
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
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

/** Reports anomalies; never repairs or guesses a historical opening balance. */
export async function findReconciliationIssues(pool: Pool, limit = 1000): Promise<ReconciliationIssue[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("invalid_reconciliation_limit");
  return accountingTransaction(pool, true, async client => {
    const result = await client.query<ReconciliationIssue>(CHECKS, [limit + 1, null, false]);
    const issues = result.rows.slice(0, limit);
    if (result.rows.length > limit) issues.push({ type: "scan_truncated", detail: `more than ${limit} issues; report is incomplete` });
    return issues;
  });
}

/** Operator supplies an independently reviewed value and reference, not an inferred balance. */
export async function recordWalletOpeningBalance(pool: Pool, walletId: string, amountMinor: number, reference: string): Promise<void> {
  if (typeof walletId !== "string" || walletId.length < 3 || walletId.length > 128 || /[\x00-\x1f\x7f]/.test(walletId) ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
      typeof reference !== "string" || reference.trim().length < 3 || reference.length > 500 || /[\x00-\x1f\x7f]/.test(reference)) {
    throw new Error("invalid_opening_balance_record");
  }
  await accountingTransaction(pool, false, async client => {
    await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = $1 FOR UPDATE", [walletId]);
    const unresolved = await client.query<ReconciliationIssue>(CHECKS, [1, walletId, true]);
    if (unresolved.rows.length) throw new Error("historical_accounting_review_required");
    const result = await client.query(`UPDATE wallets SET opening_balance_minor = $2,
      opening_balance_reference = $3, opening_balance_recorded_at = clock_timestamp()
      WHERE wallet_id = $1 AND opening_balance_minor IS NULL`, [walletId, amountMinor, `operator:${reference.trim()}`]);
    // Deferred checks validate both equations before committing this operator record.
    if (result.rowCount !== 1) throw new Error("wallet_missing_or_baseline_already_recorded");
  });
}
