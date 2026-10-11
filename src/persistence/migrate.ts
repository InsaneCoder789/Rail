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

ALTER TABLE rail_payment_executions ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rail_payment_executions ADD COLUMN IF NOT EXISTS risk_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rail_payment_executions ADD COLUMN IF NOT EXISTS risk_protection_required BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_evidence_binding ON rail_payment_executions(tx_id, request_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ledger_risk_history ON ledger_entries(wallet_id, currency, created_at DESC, id DESC) WHERE entry_type = 'debit';
CREATE TABLE IF NOT EXISTS rail_risk_observations (
  tx_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  feature_snapshot JSONB NOT NULL CHECK ((jsonb_typeof(feature_snapshot) = 'object'
    AND feature_snapshot->>'schemaVersion' = '1' AND feature_snapshot->>'source' = 'postgres_posted_payments'
    AND feature_snapshot->>'historyWindowDays' = '30' AND feature_snapshot->>'deviceChange' = 'not_assessed'
    AND (feature_snapshot->>'historyCount')::integer BETWEEN 0 AND 1000
    AND (feature_snapshot->>'recentCount')::integer BETWEEN 0 AND (feature_snapshot->>'historyCount')::integer
    AND jsonb_typeof(feature_snapshot->'historyTruncated') = 'boolean'
    AND jsonb_typeof(feature_snapshot->'receiverSeen') = 'boolean') IS TRUE),
  assessment JSONB NOT NULL CHECK ((assessment->>'mode' = 'shadow' AND assessment->>'policyVersion' = 'behaviour-shadow-v1'
    AND assessment->>'level' IN ('normal','review','insufficient_history') AND jsonb_typeof(assessment->'reasons') = 'array') IS TRUE),
  model_status TEXT NOT NULL CHECK (model_status IN ('available','currency_mismatch','not_configured')),
  model_version TEXT,
  model_hash TEXT CHECK (model_hash ~ '^[a-f0-9]{64}$'),
  synthetic BOOLEAN,
  prediction JSONB,
  FOREIGN KEY (tx_id, request_fingerprint) REFERENCES rail_payment_executions(tx_id, request_fingerprint) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((model_status = 'available' AND model_version IS NOT NULL AND model_hash IS NOT NULL AND synthetic IS NOT NULL AND prediction IS NOT NULL)
    OR (model_status <> 'available' AND model_version IS NULL AND model_hash IS NULL AND synthetic IS NULL AND prediction IS NULL))
);
ALTER TABLE rail_risk_observations DROP CONSTRAINT IF EXISTS rail_risk_observations_model_status_check;
ALTER TABLE rail_risk_observations ADD CONSTRAINT rail_risk_observations_model_status_check
  CHECK (model_status IN ('available','currency_mismatch','not_configured','not_yet_valid'));
ALTER TABLE rail_risk_observations ADD COLUMN IF NOT EXISTS protection_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rail_risk_observations ADD COLUMN IF NOT EXISTS anomaly_summary JSONB NOT NULL DEFAULT '{"status":"not_configured"}'::jsonb;
ALTER TABLE rail_risk_observations DROP CONSTRAINT IF EXISTS rail_risk_anomaly_summary_check;
ALTER TABLE rail_risk_observations ADD CONSTRAINT rail_risk_anomaly_summary_check CHECK ((
  jsonb_typeof(anomaly_summary) = 'object' AND anomaly_summary - 'status' - 'modelVersion' - 'synthetic' = '{}'::jsonb
    AND anomaly_summary->>'status' IN
    ('not_configured','currency_mismatch','not_yet_valid','insufficient_history','available') AND
  ((anomaly_summary->>'status' = 'available' AND protection_required AND jsonb_typeof(anomaly_summary->'modelVersion') = 'string'
      AND length(anomaly_summary->>'modelVersion') BETWEEN 1 AND 128 AND length(btrim(anomaly_summary->>'modelVersion')) > 0
      AND jsonb_typeof(anomaly_summary->'synthetic') = 'boolean') OR
    (anomaly_summary->>'status' <> 'available' AND NOT (anomaly_summary ? 'modelVersion') AND NOT (anomaly_summary ? 'synthetic')))
) IS TRUE);
ALTER TABLE rail_risk_observations ALTER COLUMN feature_snapshot DROP NOT NULL;
DO $$
DECLARE name TEXT;
BEGIN
  FOR name IN SELECT conname FROM pg_constraint WHERE conrelid = 'rail_risk_observations'::regclass AND contype = 'c'
    AND (pg_get_constraintdef(oid) LIKE '%feature_snapshot%' OR pg_get_constraintdef(oid) LIKE '%prediction%') LOOP
    EXECUTE format('ALTER TABLE rail_risk_observations DROP CONSTRAINT %I', name);
  END LOOP;
END $$;
ALTER TABLE rail_risk_observations ADD CONSTRAINT rail_risk_payload_check CHECK (
  (protection_required AND feature_snapshot IS NULL AND prediction IS NULL AND model_hash IS NULL) OR
  (NOT protection_required AND (jsonb_typeof(feature_snapshot) = 'object' AND feature_snapshot->>'schemaVersion' = '1'
    AND feature_snapshot->>'source' = 'postgres_posted_payments' AND feature_snapshot->>'historyWindowDays' = '30'
    AND feature_snapshot->>'deviceChange' = 'not_assessed' AND (feature_snapshot->>'historyCount')::integer BETWEEN 0 AND 1000
    AND (feature_snapshot->>'recentCount')::integer BETWEEN 0 AND (feature_snapshot->>'historyCount')::integer
    AND jsonb_typeof(feature_snapshot->'historyTruncated') = 'boolean' AND jsonb_typeof(feature_snapshot->'receiverSeen') = 'boolean') IS TRUE)
);
ALTER TABLE rail_risk_observations ADD CONSTRAINT rail_risk_model_fields_check CHECK (
  (model_status = 'available' AND model_version IS NOT NULL AND synthetic IS NOT NULL
    AND (protection_required OR (model_hash IS NOT NULL AND prediction IS NOT NULL))) OR
  (model_status <> 'available' AND model_version IS NULL AND model_hash IS NULL AND synthetic IS NULL AND prediction IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_binding ON rail_risk_observations(tx_id, request_fingerprint);
CREATE TABLE IF NOT EXISTS rail_risk_key_usage (
  key_fingerprint TEXT PRIMARY KEY CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  record_count BIGINT NOT NULL CHECK (record_count BETWEEN 1 AND 1000000)
);
CREATE TABLE IF NOT EXISTS rail_protected_risk (
  tx_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL REFERENCES rail_risk_key_usage(key_fingerprint), nonce TEXT NOT NULL,
  envelope JSONB NOT NULL, commitment TEXT NOT NULL CHECK (commitment ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tx_id, request_fingerprint) REFERENCES rail_risk_observations(tx_id, request_fingerprint) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (key_fingerprint, nonce),
  CHECK ((jsonb_typeof(envelope) = 'object' AND envelope->>'version' = '1' AND envelope->>'purpose' = 'risk-v1'
    AND envelope->>'txId' = tx_id AND envelope->>'requestFingerprint' = request_fingerprint AND envelope->>'nonce' = nonce) IS TRUE)
);
CREATE TABLE IF NOT EXISTS rail_evidence_key_usage (
  encryption_key_fingerprint TEXT PRIMARY KEY CHECK (encryption_key_fingerprint ~ '^[a-f0-9]{64}$'),
  record_count BIGINT NOT NULL CHECK (record_count BETWEEN 1 AND 1000000)
);
CREATE TABLE IF NOT EXISTS rail_transaction_evidence (
  tx_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  encryption_key_fingerprint TEXT NOT NULL REFERENCES rail_evidence_key_usage(encryption_key_fingerprint),
  nonce TEXT NOT NULL,
  envelope JSONB NOT NULL,
  commitment TEXT NOT NULL CHECK (commitment ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tx_id, request_fingerprint) REFERENCES rail_payment_executions(tx_id, request_fingerprint),
  UNIQUE (encryption_key_fingerprint, nonce),
  CHECK ((jsonb_typeof(envelope) = 'object' AND
    envelope ?& ARRAY['version','algorithm','keyId','txId','requestFingerprint','nonce','ciphertext','tag','mac'] AND
    envelope->>'version' = '1' AND envelope->>'algorithm' = 'AES-256-GCM+HMAC-SHA256' AND
    envelope->>'txId' = tx_id AND envelope->>'requestFingerprint' = request_fingerprint AND envelope->>'nonce' = nonce) IS TRUE)
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0);

CREATE TABLE IF NOT EXISTS rail_agents (
  agent_id UUID PRIMARY KEY,
  owner_wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (agent_id, owner_wallet_id),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON rail_agents(owner_wallet_id, created_at, agent_id);
CREATE TABLE IF NOT EXISTS rail_agent_credentials (
  credential_id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES rail_agents(agent_id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  scope TEXT NOT NULL CHECK (scope = 'payments:propose'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_agent ON rail_agent_credentials(agent_id);
ALTER TABLE rail_agent_credentials DROP CONSTRAINT IF EXISTS rail_agent_credentials_scope_check;
ALTER TABLE rail_agent_credentials ADD CONSTRAINT rail_agent_credentials_scope_check CHECK (scope IN ('payments:propose','payments:execute'));
CREATE TABLE IF NOT EXISTS rail_agent_mandates (
  mandate_id UUID PRIMARY KEY,
  agent_id UUID NOT NULL,
  owner_wallet_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('approval_required', 'budgeted')),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  per_payment_limit_minor BIGINT NOT NULL CHECK (per_payment_limit_minor BETWEEN 1 AND 1000000000000),
  total_budget_minor BIGINT NOT NULL CHECK (total_budget_minor BETWEEN 1 AND 1000000000000),
  allowed_receiver_wallet_ids TEXT[] NOT NULL CHECK (cardinality(allowed_receiver_wallet_ids) BETWEEN 1 AND 20 AND array_position(allowed_receiver_wallet_ids, NULL) IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (agent_id, owner_wallet_id) REFERENCES rail_agents(agent_id, owner_wallet_id),
  CHECK (per_payment_limit_minor <= total_budget_minor),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS idx_agent_mandates_agent ON rail_agent_mandates(agent_id, created_at, mandate_id);
ALTER TABLE rail_agent_mandates ADD COLUMN IF NOT EXISTS reserved_budget_minor BIGINT NOT NULL DEFAULT 0
  CHECK (reserved_budget_minor >= 0 AND reserved_budget_minor <= total_budget_minor);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mandate_owner_binding ON rail_agent_mandates(mandate_id, agent_id, owner_wallet_id);
CREATE TABLE IF NOT EXISTS rail_agent_intents (
  intent_id UUID PRIMARY KEY,
  agent_id UUID NOT NULL,
  mandate_id UUID NOT NULL,
  owner_wallet_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL CHECK (length(client_request_id) BETWEEN 8 AND 128),
  proposal_fingerprint TEXT NOT NULL CHECK (proposal_fingerprint ~ '^[a-f0-9]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  receiver_wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  terminal_reason TEXT CHECK (terminal_reason IN ('owner_rejected', 'agent_revoked', 'mandate_revoked', 'deadline_expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  FOREIGN KEY (mandate_id, agent_id, owner_wallet_id) REFERENCES rail_agent_mandates(mandate_id, agent_id, owner_wallet_id),
  UNIQUE (agent_id, client_request_id),
  CHECK (receiver_wallet_id <> owner_wallet_id),
  CHECK ((status IN ('pending','approved') AND terminal_reason IS NULL) OR
    (status IN ('rejected','expired') AND terminal_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_agent_intents_agent ON rail_agent_intents(agent_id, created_at, intent_id);
CREATE INDEX IF NOT EXISTS idx_agent_intents_mandate ON rail_agent_intents(mandate_id, status);
ALTER TABLE rail_agent_mandates ADD COLUMN IF NOT EXISTS spent_budget_minor BIGINT NOT NULL DEFAULT 0
  CHECK (spent_budget_minor >= 0 AND spent_budget_minor + reserved_budget_minor <= total_budget_minor);
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS payment_tx_id TEXT UNIQUE
  REFERENCES rail_payment_executions(tx_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid = 'rail_agent_intents'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE rail_agent_intents DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE rail_agent_intents ADD CONSTRAINT rail_agent_intent_state_check CHECK (
  (status IN ('pending','approved') AND terminal_reason IS NULL AND payment_tx_id IS NULL AND executed_at IS NULL) OR
  (status IN ('rejected','expired') AND terminal_reason IS NOT NULL AND payment_tx_id IS NULL AND executed_at IS NULL) OR
  (status = 'executed' AND terminal_reason IS NULL AND payment_tx_id = 'rail_agent:' || intent_id::text
    AND payment_tx_id IS NOT NULL AND executed_at IS NOT NULL AND executed_at >= created_at AND executed_at < expires_at)
);

CREATE OR REPLACE FUNCTION rail_assert_agent_budget(id UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rail_agent_mandates mandate WHERE mandate.mandate_id = id AND
      (mandate.reserved_budget_minor <> COALESCE((SELECT SUM(intent.amount_minor) FROM rail_agent_intents intent
        WHERE intent.mandate_id = id AND intent.status IN ('pending','approved')), 0) OR
       mandate.spent_budget_minor <> COALESCE((SELECT SUM(intent.amount_minor) FROM rail_agent_intents intent
        WHERE intent.mandate_id = id AND intent.status = 'executed'), 0))) THEN
    RAISE EXCEPTION 'agent_budget_reservation_mismatch' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION rail_check_agent_budget() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM rail_assert_agent_budget(NEW.mandate_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_agent_intent_budget_check ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_agent_intent_budget_check AFTER INSERT OR UPDATE ON rail_agent_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_budget();
DROP TRIGGER IF EXISTS rail_agent_mandate_budget_check ON rail_agent_mandates;
CREATE CONSTRAINT TRIGGER rail_agent_mandate_budget_check AFTER INSERT OR UPDATE ON rail_agent_mandates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_budget();

CREATE OR REPLACE FUNCTION rail_protect_agent_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'agent_intent_history_is_immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.intent_id, NEW.agent_id, NEW.mandate_id, NEW.owner_wallet_id, NEW.client_request_id,
      NEW.proposal_fingerprint, NEW.request_fingerprint, NEW.receiver_wallet_id, NEW.amount_minor, NEW.currency, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.intent_id, OLD.agent_id, OLD.mandate_id, OLD.owner_wallet_id, OLD.client_request_id,
      OLD.proposal_fingerprint, OLD.request_fingerprint, OLD.receiver_wallet_id, OLD.amount_minor, OLD.currency, OLD.created_at, OLD.expires_at)
    OR (OLD.status IN ('rejected','expired','executed') AND ROW(NEW.status, NEW.terminal_reason, NEW.payment_tx_id, NEW.executed_at)
      IS DISTINCT FROM ROW(OLD.status, OLD.terminal_reason, OLD.payment_tx_id, OLD.executed_at))
    OR (OLD.status = 'approved' AND NEW.status = 'pending') OR (OLD.status = 'pending' AND NEW.status = 'executed') THEN
    RAISE EXCEPTION 'agent_intent_history_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_agent_intent_immutable ON rail_agent_intents;
CREATE TRIGGER rail_agent_intent_immutable BEFORE UPDATE OR DELETE ON rail_agent_intents
  FOR EACH ROW EXECUTE FUNCTION rail_protect_agent_intent();

CREATE OR REPLACE FUNCTION rail_assert_agent_payment(id UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rail_agent_intents intent WHERE intent.intent_id = id AND intent.status = 'executed' AND NOT EXISTS (
    SELECT 1 FROM rail_payment_executions execution JOIN authorizations auth ON auth.tx_id = execution.tx_id
    WHERE execution.tx_id = intent.payment_tx_id AND execution.idempotency_key = 'rail_agent_intent:' || id::text
      AND execution.evidence_required AND execution.result_json->>'status' = 'accepted' AND auth.status = 'used'
      AND auth.sender_wallet_id = intent.owner_wallet_id AND auth.receiver_wallet_id = intent.receiver_wallet_id
      AND auth.amount_minor = intent.amount_minor AND auth.currency = intent.currency)) THEN
    RAISE EXCEPTION 'agent_payment_binding_mismatch' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION rail_check_agent_payment() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE id UUID;
BEGIN
  IF TG_TABLE_NAME = 'rail_agent_intents' THEN id := NEW.intent_id;
  ELSIF NEW.tx_id LIKE 'rail_agent:%' THEN
    SELECT intent_id INTO id FROM rail_agent_intents WHERE payment_tx_id = NEW.tx_id AND status = 'executed';
    IF id IS NULL THEN RAISE EXCEPTION 'agent_payment_binding_mismatch' USING ERRCODE = '23514'; END IF;
  ELSE RETURN NULL;
  END IF;
  PERFORM rail_assert_agent_payment(id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_agent_payment_check ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_agent_payment_check AFTER INSERT OR UPDATE ON rail_agent_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_payment();
DROP TRIGGER IF EXISTS rail_execution_agent_check ON rail_payment_executions;
CREATE CONSTRAINT TRIGGER rail_execution_agent_check AFTER INSERT ON rail_payment_executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_payment();

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
  IF EXISTS (SELECT 1 FROM rail_payment_executions execution
      WHERE execution.tx_id = payment_tx_id AND execution.evidence_required
        AND NOT EXISTS (SELECT 1 FROM rail_transaction_evidence evidence
          WHERE evidence.tx_id = execution.tx_id AND evidence.request_fingerprint = execution.request_fingerprint)) THEN
    RAISE EXCEPTION 'payment_evidence_missing' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM rail_payment_executions execution WHERE execution.tx_id = payment_tx_id AND execution.risk_required
      AND NOT EXISTS (SELECT 1 FROM rail_risk_observations observation WHERE observation.tx_id = execution.tx_id
        AND observation.request_fingerprint = execution.request_fingerprint)) THEN
    RAISE EXCEPTION 'payment_risk_observation_missing' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM rail_payment_executions execution WHERE execution.tx_id = payment_tx_id AND execution.risk_protection_required
      AND NOT EXISTS (SELECT 1 FROM rail_risk_observations observation WHERE observation.tx_id = execution.tx_id AND observation.protection_required))
    OR EXISTS (SELECT 1 FROM rail_risk_observations observation WHERE observation.tx_id = payment_tx_id AND observation.protection_required
      AND NOT EXISTS (SELECT 1 FROM rail_protected_risk protected WHERE protected.tx_id = observation.tx_id
        AND protected.request_fingerprint = observation.request_fingerprint)) THEN
    RAISE EXCEPTION 'payment_risk_protection_missing' USING ERRCODE = '23514';
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
DROP TRIGGER IF EXISTS rail_evidence_immutable ON rail_transaction_evidence;
CREATE TRIGGER rail_evidence_immutable BEFORE UPDATE OR DELETE ON rail_transaction_evidence
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_risk_immutable ON rail_risk_observations;
CREATE TRIGGER rail_risk_immutable BEFORE UPDATE OR DELETE ON rail_risk_observations
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_protected_risk_immutable ON rail_protected_risk;
CREATE TRIGGER rail_protected_risk_immutable BEFORE UPDATE OR DELETE ON rail_protected_risk
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_risk_commit_check ON rail_risk_observations;
CREATE CONSTRAINT TRIGGER rail_risk_commit_check AFTER INSERT ON rail_risk_observations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_payment_commit();
DROP TRIGGER IF EXISTS rail_protected_risk_commit_check ON rail_protected_risk;
CREATE CONSTRAINT TRIGGER rail_protected_risk_commit_check AFTER INSERT ON rail_protected_risk
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_payment_commit();

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
