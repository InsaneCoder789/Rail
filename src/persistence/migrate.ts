import type { Pool } from "pg";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rail_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  result_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rail_offline_tokens (
  token_id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  amount_cap_minor BIGINT NOT NULL,
  remaining_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  issued_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_wallet ON rail_offline_tokens(wallet_id);
CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_expires ON rail_offline_tokens(expires_at_ms);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL,
  reserved BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_updated_at ON wallets(updated_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id SERIAL PRIMARY KEY,
  tx_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet ON ledger_entries(wallet_id);

CREATE TABLE IF NOT EXISTS authorization_usage (
  auth_id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  api_key TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_wallet ON api_keys(wallet_id);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  wallet_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_id);
`;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
  } finally {
    client.release();
  }
}
