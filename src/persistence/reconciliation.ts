import type { Pool } from "pg";

export interface ReconciliationIssue {
  readonly type: "unbalanced_ledger" | "invalid_wallet_reservation" | "orphan_authorization_usage";
  readonly txId?: string;
  readonly walletId?: string;
  readonly detail: string;
}

/** Finds accounting anomalies without changing financial state. */
export async function findReconciliationIssues(pool: Pool): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];
  const ledger = await pool.query(
    `SELECT tx_id,
            COUNT(*)::int AS entry_count,
            SUM(CASE WHEN entry_type = 'debit' THEN amount_minor ELSE -amount_minor END)::bigint AS imbalance
     FROM ledger_entries
     GROUP BY tx_id
     HAVING COUNT(*) <> 2 OR SUM(CASE WHEN entry_type = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
  );
  for (const row of ledger.rows as Array<{ tx_id: string; entry_count: number; imbalance: string }>) {
    issues.push({
      type: "unbalanced_ledger",
      txId: row.tx_id,
      detail: `expected two balanced entries; found ${row.entry_count} with imbalance ${row.imbalance}`,
    });
  }

  const wallets = await pool.query(
    `SELECT wallet_id, balance, reserved
     FROM wallets
     WHERE balance < 0 OR reserved < 0`,
  );
  for (const row of wallets.rows as Array<{ wallet_id: string; balance: string; reserved: string }>) {
    issues.push({
      type: "invalid_wallet_reservation",
      walletId: row.wallet_id,
      detail: `wallet has balance ${row.balance} and reserved amount ${row.reserved}`,
    });
  }

  const orphanUsage = await pool.query(
    `SELECT usage.auth_id, usage.tx_id
     FROM authorization_usage usage
     LEFT JOIN authorizations auth ON auth.auth_id = usage.auth_id
     WHERE auth.auth_id IS NULL`,
  );
  for (const row of orphanUsage.rows as Array<{ auth_id: string; tx_id: string }>) {
    issues.push({
      type: "orphan_authorization_usage",
      txId: row.tx_id,
      detail: `authorization usage ${row.auth_id} does not reference an existing authorization`,
    });
  }

  return issues;
}
