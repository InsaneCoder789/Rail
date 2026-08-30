import type { Pool } from "pg";

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rail_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL CHECK (hit_count >= 0)
);

CREATE TABLE IF NOT EXISTS rail_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  result_json JSONB,
  error_message TEXT,
  request_fingerprint TEXT,
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rail_offline_tokens_amounts_non_negative') THEN
    ALTER TABLE rail_offline_tokens ADD CONSTRAINT rail_offline_tokens_amounts_non_negative
      CHECK (amount_cap_minor > 0 AND remaining_minor >= 0 AND remaining_minor <= amount_cap_minor);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_wallet ON rail_offline_tokens(wallet_id);
CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_expires ON rail_offline_tokens(expires_at_ms);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL,
  reserved BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_amounts_non_negative') THEN
    ALTER TABLE wallets ADD CONSTRAINT wallets_amounts_non_negative
      CHECK (balance >= 0 AND reserved >= 0);
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_amount_positive') THEN
    ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_positive
      CHECK (amount_minor > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet ON ledger_entries(wallet_id);

CREATE TABLE IF NOT EXISTS authorizations (
  auth_id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL UNIQUE,
  sender_wallet_id TEXT NOT NULL,
  receiver_wallet_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('issued', 'used', 'expired', 'revoked')),
  signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_amount_positive') THEN
    ALTER TABLE authorizations ADD CONSTRAINT authorizations_amount_positive
      CHECK (amount_minor > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_distinct_wallets') THEN
    ALTER TABLE authorizations ADD CONSTRAINT authorizations_distinct_wallets
      CHECK (sender_wallet_id <> receiver_wallet_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_authorizations_sender ON authorizations(sender_wallet_id);
CREATE INDEX IF NOT EXISTS idx_authorizations_status_expires ON authorizations(status, expires_at);

CREATE TABLE IF NOT EXISTS authorization_usage (
  auth_id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authorization_usage_tx
  ON authorization_usage(tx_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_tx_type
  ON ledger_entries(tx_id, entry_type);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'api_key'
  ) THEN
    ALTER TABLE api_keys RENAME TO api_keys_legacy;
  END IF;
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL UNIQUE,
  wallet_id TEXT NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'api_keys_legacy'
  ) THEN
    INSERT INTO api_keys (key_id, api_key_hash, wallet_id)
    SELECT
      'key_' || substr(encode(digest(api_key, 'sha256'), 'hex'), 1, 16),
      encode(digest(api_key, 'sha256'), 'hex'),
      wallet_id
    FROM api_keys_legacy
    ON CONFLICT (api_key_hash) DO NOTHING;

    DROP TABLE api_keys_legacy;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_keys_wallet ON api_keys(wallet_id);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  wallet_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_wallet_fk') THEN
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_sender_wallet_fk') THEN
    ALTER TABLE authorizations
      ADD CONSTRAINT authorizations_sender_wallet_fk FOREIGN KEY (sender_wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_receiver_wallet_fk') THEN
    ALTER TABLE authorizations
      ADD CONSTRAINT authorizations_receiver_wallet_fk FOREIGN KEY (receiver_wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorization_usage_auth_fk') THEN
    ALTER TABLE authorization_usage
      ADD CONSTRAINT authorization_usage_auth_fk FOREIGN KEY (auth_id) REFERENCES authorizations(auth_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_wallet_fk') THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_wallet_fk') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
END $$;

ALTER TABLE rail_idempotency
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
`;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
  } finally {
    client.release();
  }
}

export async function ensureOutboxSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outbox_occurred_at_desc
    ON outbox (occurred_at DESC);
  `);
}
