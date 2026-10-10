import type { Pool, PoolClient } from "pg";

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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rail_offline_tokens_amounts_non_negative' AND conrelid = 'rail_offline_tokens'::regclass) THEN
    ALTER TABLE rail_offline_tokens ADD CONSTRAINT rail_offline_tokens_amounts_non_negative
      CHECK (amount_cap_minor > 0 AND remaining_minor >= 0 AND remaining_minor <= amount_cap_minor);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_wallet ON rail_offline_tokens(wallet_id);
CREATE INDEX IF NOT EXISTS idx_rail_offline_tokens_expires ON rail_offline_tokens(expires_at_ms);

CREATE TABLE IF NOT EXISTS rail_offline_spends (
  tx_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES rail_offline_tokens(token_id),
  request_fingerprint TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'finalized', 'rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rail_offline_spends_token ON rail_offline_spends(token_id);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL,
  reserved BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_amounts_non_negative' AND conrelid = 'wallets'::regclass) THEN
    ALTER TABLE wallets ADD CONSTRAINT wallets_amounts_non_negative
      CHECK (balance >= 0 AND reserved >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wallets_updated_at ON wallets(updated_at);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS opening_balance_minor BIGINT,
  ADD COLUMN IF NOT EXISTS opening_balance_reference TEXT,
  ADD COLUMN IF NOT EXISTS opening_balance_recorded_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_opening_balance_valid' AND conrelid = 'wallets'::regclass) THEN
    ALTER TABLE wallets ADD CONSTRAINT wallet_opening_balance_valid CHECK (
      CASE WHEN opening_balance_minor IS NULL THEN opening_balance_reference IS NULL AND opening_balance_recorded_at IS NULL
      ELSE opening_balance_minor BETWEEN 0 AND 9007199254740991
        AND opening_balance_reference IS NOT NULL AND length(opening_balance_reference) BETWEEN 1 AND 512
        AND opening_balance_recorded_at IS NOT NULL END
    );
  END IF;
END $$;

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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_amount_positive' AND conrelid = 'ledger_entries'::regclass) THEN
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_amount_positive' AND conrelid = 'authorizations'::regclass) THEN
    ALTER TABLE authorizations ADD CONSTRAINT authorizations_amount_positive
      CHECK (amount_minor > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_distinct_wallets' AND conrelid = 'authorizations'::regclass) THEN
    ALTER TABLE authorizations ADD CONSTRAINT authorizations_distinct_wallets
      CHECK (sender_wallet_id <> receiver_wallet_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_authorizations_sender ON authorizations(sender_wallet_id);
CREATE INDEX IF NOT EXISTS idx_authorizations_status_expires ON authorizations(status, expires_at);

CREATE TABLE IF NOT EXISTS rail_payment_executions (
  tx_id TEXT PRIMARY KEY REFERENCES authorizations(tx_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  result_json JSONB NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = 'api_key'
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
    WHERE table_schema = current_schema() AND table_name = 'api_keys_legacy'
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_wallet_fk' AND conrelid = 'ledger_entries'::regclass) THEN
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_sender_wallet_fk' AND conrelid = 'authorizations'::regclass) THEN
    ALTER TABLE authorizations
      ADD CONSTRAINT authorizations_sender_wallet_fk FOREIGN KEY (sender_wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorizations_receiver_wallet_fk' AND conrelid = 'authorizations'::regclass) THEN
    ALTER TABLE authorizations
      ADD CONSTRAINT authorizations_receiver_wallet_fk FOREIGN KEY (receiver_wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorization_usage_auth_fk' AND conrelid = 'authorization_usage'::regclass) THEN
    ALTER TABLE authorization_usage
      ADD CONSTRAINT authorization_usage_auth_fk FOREIGN KEY (auth_id) REFERENCES authorizations(auth_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_wallet_fk' AND conrelid = 'api_keys'::regclass) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_wallet_fk' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets(wallet_id) NOT VALID;
  END IF;
END $$;

ALTER TABLE rail_idempotency
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_authorizations_identity ON authorizations(auth_id, tx_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorization_usage_identity_fk' AND conrelid = 'authorization_usage'::regclass) THEN
    ALTER TABLE authorization_usage ADD CONSTRAINT authorization_usage_identity_fk
      FOREIGN KEY (auth_id, tx_id) REFERENCES authorizations(auth_id, tx_id) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rail_wallet_baseline() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.opening_balance_minor := NEW.balance + NEW.reserved;
    NEW.opening_balance_reference := 'wallet_created';
    NEW.opening_balance_recorded_at := clock_timestamp();
  ELSE
    IF NEW.currency IS DISTINCT FROM OLD.currency OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id THEN
      RAISE EXCEPTION 'wallet_identity_is_immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.opening_balance_minor IS NOT NULL AND
       ROW(NEW.opening_balance_minor, NEW.opening_balance_reference, NEW.opening_balance_recorded_at)
       IS DISTINCT FROM ROW(OLD.opening_balance_minor, OLD.opening_balance_reference, OLD.opening_balance_recorded_at) THEN
      RAISE EXCEPTION 'wallet_baseline_is_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_wallet_baseline_capture ON wallets;
CREATE TRIGGER rail_wallet_baseline_capture BEFORE INSERT OR UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION rail_wallet_baseline();

CREATE OR REPLACE FUNCTION rail_assert_wallet(payment_wallet_id TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  wallet_record wallets%ROWTYPE;
  movement NUMERIC;
  reservation NUMERIC;
BEGIN
  SELECT * INTO wallet_record FROM wallets WHERE wallet_id = payment_wallet_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF wallet_record.currency IS NULL OR wallet_record.currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'wallet_currency_invalid' USING ERRCODE = '23514';
  END IF;
  IF wallet_record.opening_balance_minor IS NULL THEN
    RAISE EXCEPTION 'accounting_baseline_required' USING ERRCODE = '23514';
  END IF;
  IF wallet_record.balance IS NULL OR wallet_record.reserved IS NULL OR wallet_record.balance < 0 OR wallet_record.reserved < 0 THEN
    RAISE EXCEPTION 'wallet_amount_invalid' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE wallet_id = payment_wallet_id AND currency <> wallet_record.currency) THEN
    RAISE EXCEPTION 'wallet_ledger_currency_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(CASE entry_type WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO movement FROM ledger_entries WHERE wallet_id = payment_wallet_id;
  SELECT COALESCE(SUM(amount_minor), 0) INTO reservation FROM authorizations
    WHERE sender_wallet_id = payment_wallet_id AND status = 'issued';
  IF wallet_record.balance::numeric + wallet_record.reserved <> wallet_record.opening_balance_minor::numeric + movement
     OR wallet_record.balance::numeric + wallet_record.reserved > 9007199254740991 THEN
    RAISE EXCEPTION 'wallet_balance_equation_failed' USING ERRCODE = '23514';
  END IF;
  IF wallet_record.reserved <> reservation THEN
    RAISE EXCEPTION 'wallet_reservation_equation_failed' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rail_check_wallet_commit() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM rail_assert_wallet(NEW.wallet_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_wallet_commit_check ON wallets;
CREATE CONSTRAINT TRIGGER rail_wallet_commit_check AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_wallet_commit();

CREATE OR REPLACE FUNCTION rail_check_authorization_wallet() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN PERFORM rail_assert_wallet(NEW.sender_wallet_id); END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM rail_assert_wallet(OLD.sender_wallet_id); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_authorization_wallet_check ON authorizations;
CREATE CONSTRAINT TRIGGER rail_authorization_wallet_check AFTER INSERT OR UPDATE OR DELETE ON authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_authorization_wallet();

-- Defer complete-payment validation until every stage has written its rows.
CREATE OR REPLACE FUNCTION rail_assert_payment(payment_tx_id TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  auth_record authorizations%ROWTYPE;
  entry_count INTEGER;
  entries_match BOOLEAN;
BEGIN
  SELECT * INTO auth_record FROM authorizations WHERE tx_id = payment_tx_id;
  IF NOT FOUND OR auth_record.status <> 'used' THEN
    RAISE EXCEPTION 'payment_authorization_not_used' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*), BOOL_AND(
    amount_minor = auth_record.amount_minor AND currency = auth_record.currency AND
    wallet_id = CASE entry_type WHEN 'debit' THEN auth_record.sender_wallet_id ELSE auth_record.receiver_wallet_id END
  ) INTO entry_count, entries_match FROM ledger_entries WHERE tx_id = payment_tx_id;
  IF entry_count <> 2 OR entries_match IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'payment_ledger_pair_invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM rail_assert_wallet(auth_record.sender_wallet_id);
  PERFORM rail_assert_wallet(auth_record.receiver_wallet_id);
  IF NOT EXISTS (SELECT 1 FROM authorization_usage WHERE tx_id = payment_tx_id AND auth_id = auth_record.auth_id)
     OR NOT EXISTS (
       SELECT 1 FROM rail_payment_executions execution
       JOIN rail_idempotency replay ON replay.idempotency_key = execution.idempotency_key
       WHERE execution.tx_id = payment_tx_id AND replay.status = 'completed'
         AND replay.request_fingerprint = execution.request_fingerprint
         AND replay.result_json = execution.result_json
     ) THEN
    RAISE EXCEPTION 'payment_commit_record_missing' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rail_check_payment_commit() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM rail_assert_payment(NEW.tx_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS rail_ledger_commit_check ON ledger_entries;
CREATE CONSTRAINT TRIGGER rail_ledger_commit_check AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_payment_commit();
DROP TRIGGER IF EXISTS rail_usage_commit_check ON authorization_usage;
CREATE CONSTRAINT TRIGGER rail_usage_commit_check AFTER INSERT ON authorization_usage
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_payment_commit();
DROP TRIGGER IF EXISTS rail_execution_commit_check ON rail_payment_executions;
CREATE CONSTRAINT TRIGGER rail_execution_commit_check AFTER INSERT ON rail_payment_executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_payment_commit();
DROP TRIGGER IF EXISTS rail_authorization_commit_check ON authorizations;
CREATE CONSTRAINT TRIGGER rail_authorization_commit_check AFTER INSERT OR UPDATE ON authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'used') EXECUTE FUNCTION rail_check_payment_commit();

CREATE OR REPLACE FUNCTION rail_reject_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'posted_payment_history_is_immutable' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS rail_ledger_immutable ON ledger_entries;
CREATE TRIGGER rail_ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_usage_immutable ON authorization_usage;
CREATE TRIGGER rail_usage_immutable BEFORE UPDATE OR DELETE ON authorization_usage
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_execution_immutable ON rail_payment_executions;
CREATE TRIGGER rail_execution_immutable BEFORE UPDATE OR DELETE ON rail_payment_executions
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();

CREATE OR REPLACE FUNCTION rail_protect_used_authorization() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'used' AND ROW(NEW.auth_id, NEW.tx_id, NEW.sender_wallet_id, NEW.receiver_wallet_id,
      NEW.amount_minor, NEW.currency, NEW.status, NEW.signature, NEW.created_at, NEW.used_at)
      IS DISTINCT FROM ROW(OLD.auth_id, OLD.tx_id, OLD.sender_wallet_id, OLD.receiver_wallet_id,
      OLD.amount_minor, OLD.currency, OLD.status, OLD.signature, OLD.created_at, OLD.used_at) THEN
    RAISE EXCEPTION 'used_authorization_financial_fields_are_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_used_authorization_immutable ON authorizations;
CREATE TRIGGER rail_used_authorization_immutable BEFORE UPDATE ON authorizations
  FOR EACH ROW EXECUTE FUNCTION rail_protect_used_authorization();
`;

async function migrateTransaction(pool: Pool, work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  const onError = () => { discard = true; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    // Also protects extension creation when two fresh schemas migrate simultaneously.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rail:schema:migrate', 0))");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
    client.removeListener("error", onError);
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await migrateTransaction(pool, async client => { await client.query(SCHEMA); });
}

export async function ensureOutboxSchema(pool: Pool): Promise<void> {
  await migrateTransaction(pool, async client => {
    await client.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_outbox_occurred_at_desc
    ON outbox (occurred_at DESC);
  `);
    await client.query(`
    ALTER TABLE outbox
      ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'processing', 'delivered', 'dead_letter')),
      ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS lease_id UUID,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;
    CREATE INDEX IF NOT EXISTS idx_outbox_delivery
      ON outbox (next_attempt_at, id) WHERE delivery_status IN ('pending', 'processing');
    CREATE INDEX IF NOT EXISTS idx_outbox_sender_history
      ON outbox ((payload->>'senderWalletId'), id DESC) WHERE type <> 'system.error';
    CREATE INDEX IF NOT EXISTS idx_outbox_receiver_history
      ON outbox ((payload->>'receiverWalletId'), id DESC) WHERE type <> 'system.error';
    CREATE INDEX IF NOT EXISTS idx_outbox_wallet_history
      ON outbox ((payload->>'walletId'), id DESC) WHERE type <> 'system.error';
    `);
  });
}
