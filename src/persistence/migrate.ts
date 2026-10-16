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

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_commitment_binding ON rail_transaction_evidence(tx_id, commitment);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_commitment_binding ON rail_protected_risk(tx_id, commitment);
CREATE TABLE IF NOT EXISTS rail_audit_batches (
  batch_id UUID PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  root TEXT NOT NULL CHECK (root ~ '^[a-f0-9]{64}$'), leaf_count INTEGER NOT NULL CHECK (leaf_count BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS rail_audit_memberships (
  tx_id TEXT PRIMARY KEY REFERENCES rail_payment_executions(tx_id), batch_id UUID NOT NULL REFERENCES rail_audit_batches(batch_id),
  leaf_index INTEGER NOT NULL CHECK (leaf_index BETWEEN 0 AND 255), leaf_hash TEXT NOT NULL CHECK (leaf_hash ~ '^[a-f0-9]{64}$'),
  payment_commitment TEXT NOT NULL, risk_commitment TEXT, proof JSONB NOT NULL,
  FOREIGN KEY (tx_id, payment_commitment) REFERENCES rail_transaction_evidence(tx_id, commitment),
  FOREIGN KEY (tx_id, risk_commitment) REFERENCES rail_protected_risk(tx_id, commitment),
  UNIQUE (batch_id, leaf_index),
  CHECK ((jsonb_typeof(proof) = 'object' AND proof - 'leafCount' - 'leafIndex' - 'siblings' = '{}'::jsonb
    AND jsonb_typeof(proof->'leafIndex') = 'number' AND (proof->>'leafIndex')::integer = leaf_index
    AND jsonb_typeof(proof->'leafCount') = 'number' AND (proof->>'leafCount')::integer BETWEEN 1 AND 256
    AND jsonb_typeof(proof->'siblings') = 'array' AND jsonb_array_length(proof->'siblings') <= 8) IS TRUE)
);
CREATE TABLE IF NOT EXISTS rail_audit_pending (
  tx_id TEXT PRIMARY KEY REFERENCES rail_payment_executions(tx_id), queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_audit_pending_order ON rail_audit_pending(queued_at, tx_id);
INSERT INTO rail_audit_pending(tx_id)
  SELECT evidence.tx_id FROM rail_transaction_evidence evidence JOIN rail_payment_executions execution ON execution.tx_id = evidence.tx_id
  WHERE execution.evidence_required AND NOT EXISTS (SELECT 1 FROM rail_audit_memberships membership WHERE membership.tx_id = evidence.tx_id)
  ON CONFLICT (tx_id) DO NOTHING;

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
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION rail_protect_wallet_key() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.key_id,NEW.api_key_hash,NEW.wallet_id) IS DISTINCT FROM ROW(OLD.key_id,OLD.api_key_hash,OLD.wallet_id)
    OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'wallet_key_history_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_wallet_key_protect ON api_keys;
CREATE TRIGGER rail_wallet_key_protect BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION rail_protect_wallet_key();
ALTER TABLE rail_offline_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION rail_protect_offline_revocation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'offline_token_revocation_is_permanent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_offline_token_revocation ON rail_offline_tokens;
CREATE TRIGGER rail_offline_token_revocation BEFORE UPDATE ON rail_offline_tokens FOR EACH ROW EXECUTE FUNCTION rail_protect_offline_revocation();

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_unique ON users(wallet_id);
DROP INDEX IF EXISTS idx_users_wallet;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_recovery_pending BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS rail_owner_passkeys (
  credential_id TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 2048),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  public_key BYTEA NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 4096),
  sign_count BIGINT NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up BOOLEAN NOT NULL CHECK (device_type='multiDevice' OR NOT backed_up),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_owner_passkeys_user ON rail_owner_passkeys(user_id, created_at);
CREATE TABLE IF NOT EXISTS rail_owner_challenges (
  challenge_id UUID PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), auth_version INTEGER NOT NULL CHECK (auth_version>=0),
  session_fingerprint TEXT NOT NULL CHECK (session_fingerprint ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('registration','authentication')),
  challenge TEXT NOT NULL CHECK (length(challenge) BETWEEN 32 AND 256),
  operation TEXT NOT NULL CHECK (operation IN ('agent_credential','agent_mandate','agent_approval','passkey_enroll','passkey_revoke','recovery_codes')),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[a-f0-9]{64}$'), bootstrap BOOLEAN NOT NULL,
  rp_id TEXT NOT NULL, origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ, CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK(used_at IS NULL OR used_at>=created_at), CHECK(kind='registration' OR NOT bootstrap)
);
CREATE INDEX IF NOT EXISTS idx_owner_challenges_user ON rail_owner_challenges(user_id, expires_at);
CREATE TABLE IF NOT EXISTS rail_owner_step_up_grants (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  challenge_id UUID NOT NULL UNIQUE REFERENCES rail_owner_challenges(challenge_id),
  credential_id TEXT NOT NULL REFERENCES rail_owner_passkeys(credential_id), user_id TEXT NOT NULL REFERENCES users(user_id),
  auth_version INTEGER NOT NULL CHECK (auth_version>=0), session_fingerprint TEXT NOT NULL CHECK (session_fingerprint ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('agent_credential','agent_mandate','agent_approval','passkey_enroll','passkey_revoke','recovery_codes')),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ, CHECK(expires_at>created_at AND expires_at<=created_at+interval '2 minutes'),
  CHECK(consumed_at IS NULL OR consumed_at>=created_at)
);
CREATE INDEX IF NOT EXISTS idx_owner_grants_user ON rail_owner_step_up_grants(user_id, expires_at);
CREATE TABLE IF NOT EXISTS rail_owner_recovery_codes (
  code_hash TEXT PRIMARY KEY CHECK(code_hash ~ '^[a-f0-9]{64}$'), user_id TEXT NOT NULL REFERENCES users(user_id),
  generation_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), consumed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  CHECK(consumed_at IS NULL OR consumed_at>=created_at), CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  CHECK(consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_owner_recovery_codes_user ON rail_owner_recovery_codes(user_id, generation_id);
CREATE TABLE IF NOT EXISTS rail_owner_recoveries (
  recovery_id UUID PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), auth_version INTEGER NOT NULL CHECK(auth_version>=0),
  token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), session_fingerprint TEXT NOT NULL CHECK(session_fingerprint ~ '^[a-f0-9]{64}$'),
  rp_id TEXT NOT NULL, origin TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ, superseded_at TIMESTAMPTZ,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK(completed_at IS NULL OR (completed_at>=created_at AND completed_at<expires_at)),
  CHECK(superseded_at IS NULL OR superseded_at>=created_at), CHECK(completed_at IS NULL OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_single_pending_recovery ON rail_owner_recoveries(user_id) WHERE completed_at IS NULL AND superseded_at IS NULL;
ALTER TABLE rail_owner_recoveries ADD COLUMN IF NOT EXISTS consumed_code_hash TEXT REFERENCES rail_owner_recovery_codes(code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_recovery_code_use ON rail_owner_recoveries(consumed_code_hash) WHERE consumed_code_hash IS NOT NULL;
CREATE OR REPLACE FUNCTION rail_check_owner_recovery_code() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.consumed_code_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM rail_owner_recovery_codes code WHERE code.code_hash=NEW.consumed_code_hash AND code.user_id=NEW.user_id
      AND code.consumed_at IS NOT NULL AND code.consumed_at<=NEW.created_at AND code.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'owner_recovery_code_binding_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_owner_recovery_code_binding_commit ON rail_owner_recoveries;
CREATE CONSTRAINT TRIGGER rail_owner_recovery_code_binding_commit AFTER INSERT ON rail_owner_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_owner_recovery_code();
ALTER TABLE rail_owner_challenges ADD COLUMN IF NOT EXISTS authorization_challenge_id UUID REFERENCES rail_owner_step_up_grants(challenge_id);
ALTER TABLE rail_owner_challenges ADD COLUMN IF NOT EXISTS recovery_id UUID REFERENCES rail_owner_recoveries(recovery_id);
ALTER TABLE rail_owner_passkeys ADD COLUMN IF NOT EXISTS enrollment_challenge_id UUID REFERENCES rail_owner_challenges(challenge_id);
ALTER TABLE rail_owner_passkeys ADD COLUMN IF NOT EXISTS recovery_id UUID REFERENCES rail_owner_recoveries(recovery_id);
CREATE OR REPLACE FUNCTION rail_protect_owner_recovery() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='rail_owner_recovery_codes' THEN
    IF (to_jsonb(NEW)-ARRAY['consumed_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','revoked_at']) OR
      ((OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'owner_recovery_code_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['completed_at','superseded_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['completed_at','superseded_at']) OR
      ((OLD.completed_at IS NOT NULL OR OLD.superseded_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'owner_recovery_is_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_owner_recovery_code_protect ON rail_owner_recovery_codes;
CREATE TRIGGER rail_owner_recovery_code_protect BEFORE UPDATE ON rail_owner_recovery_codes FOR EACH ROW EXECUTE FUNCTION rail_protect_owner_recovery();
DROP TRIGGER IF EXISTS rail_owner_recovery_protect ON rail_owner_recoveries;
CREATE TRIGGER rail_owner_recovery_protect BEFORE UPDATE ON rail_owner_recoveries FOR EACH ROW EXECUTE FUNCTION rail_protect_owner_recovery();
CREATE OR REPLACE FUNCTION rail_protect_owner_security() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='rail_owner_passkeys' THEN
    IF ROW(NEW.credential_id,NEW.user_id,NEW.public_key,NEW.device_type,NEW.created_at,NEW.enrollment_challenge_id,NEW.recovery_id)
       IS DISTINCT FROM ROW(OLD.credential_id,OLD.user_id,OLD.public_key,OLD.device_type,OLD.created_at,OLD.enrollment_challenge_id,OLD.recovery_id)
       OR NEW.sign_count<OLD.sign_count OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'owner_passkey_history_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='rail_owner_challenges' THEN
    IF (to_jsonb(NEW)-'used_at') IS DISTINCT FROM (to_jsonb(OLD)-'used_at') OR
      (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) OR (NEW.used_at IS NOT NULL AND NEW.used_at>=NEW.expires_at) THEN
      RAISE EXCEPTION 'owner_challenge_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') OR
      (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) OR (NEW.consumed_at IS NOT NULL AND NEW.consumed_at>=NEW.expires_at) THEN
      RAISE EXCEPTION 'owner_step_up_grant_is_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_owner_key_protect ON rail_owner_passkeys;
CREATE TRIGGER rail_owner_key_protect BEFORE UPDATE ON rail_owner_passkeys FOR EACH ROW EXECUTE FUNCTION rail_protect_owner_security();
DROP TRIGGER IF EXISTS rail_owner_challenge_protect ON rail_owner_challenges;
CREATE TRIGGER rail_owner_challenge_protect BEFORE UPDATE ON rail_owner_challenges FOR EACH ROW EXECUTE FUNCTION rail_protect_owner_security();
DROP TRIGGER IF EXISTS rail_owner_grant_protect ON rail_owner_step_up_grants;
CREATE TRIGGER rail_owner_grant_protect BEFORE UPDATE ON rail_owner_step_up_grants FOR EACH ROW EXECUTE FUNCTION rail_protect_owner_security();

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
ALTER TABLE rail_agent_credentials ADD COLUMN IF NOT EXISTS owner_step_up_challenge_id UUID REFERENCES rail_owner_step_up_grants(challenge_id);
ALTER TABLE rail_agent_credentials ADD COLUMN IF NOT EXISTS proof_public_key JSONB;
ALTER TABLE rail_agent_credentials ADD COLUMN IF NOT EXISTS proof_key_thumbprint TEXT;
ALTER TABLE rail_agent_credentials ADD COLUMN IF NOT EXISTS rotated_from_credential_id UUID REFERENCES rail_agent_credentials(credential_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credential_rotation ON rail_agent_credentials(rotated_from_credential_id) WHERE rotated_from_credential_id IS NOT NULL;
ALTER TABLE rail_agent_credentials DROP CONSTRAINT IF EXISTS rail_agent_rotation_binding;
ALTER TABLE rail_agent_credentials ADD CONSTRAINT rail_agent_rotation_binding CHECK (
  rotated_from_credential_id IS NULL OR (rotated_from_credential_id<>credential_id AND proof_public_key IS NOT NULL AND owner_step_up_challenge_id IS NOT NULL));
ALTER TABLE rail_agent_credentials DROP CONSTRAINT IF EXISTS rail_agent_proof_key_binding;
ALTER TABLE rail_agent_credentials ADD CONSTRAINT rail_agent_proof_key_binding CHECK (
  (proof_public_key IS NULL AND proof_key_thumbprint IS NULL) OR
  (proof_public_key IS NOT NULL AND proof_key_thumbprint IS NOT NULL AND owner_step_up_challenge_id IS NOT NULL
   AND proof_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credential_owner_grant ON rail_agent_credentials(owner_step_up_challenge_id) WHERE owner_step_up_challenge_id IS NOT NULL;
CREATE OR REPLACE FUNCTION rail_check_credential_step_up() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.rotated_from_credential_id IS NOT NULL AND (
    NOT EXISTS(SELECT 1 FROM rail_agent_credentials source WHERE source.credential_id=NEW.rotated_from_credential_id
      AND source.agent_id=NEW.agent_id AND source.scope=NEW.scope AND source.revoked_at=NEW.created_at
      AND source.created_at<NEW.created_at AND source.expires_at>NEW.created_at)
    OR EXISTS(SELECT 1 FROM rail_agent_credentials history WHERE history.agent_id=NEW.agent_id
      AND history.credential_id<>NEW.credential_id AND history.proof_key_thumbprint=NEW.proof_key_thumbprint)) THEN
    RAISE EXCEPTION 'agent_rotation_binding_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.proof_public_key IS NOT NULL AND (
    NEW.proof_public_key IS DISTINCT FROM jsonb_build_object('kty','OKP','crv','Ed25519','x',NEW.proof_public_key->>'x')
    OR COALESCE(NEW.proof_public_key->>'x','') !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    OR NEW.proof_key_thumbprint IS DISTINCT FROM translate(rtrim(encode(sha256(convert_to(
      '{"crv":"Ed25519","kty":"OKP","x":"' || (NEW.proof_public_key->>'x') || '"}', 'UTF8')), 'base64'), '='), '+/', '-_')) THEN
    RAISE EXCEPTION 'agent_proof_key_binding_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.owner_step_up_challenge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM rail_owner_step_up_grants grant_record JOIN users owner ON owner.user_id=grant_record.user_id
      JOIN rail_agents agent ON agent.agent_id=NEW.agent_id
    WHERE grant_record.challenge_id=NEW.owner_step_up_challenge_id AND grant_record.operation='agent_credential'
      AND grant_record.consumed_at IS NOT NULL AND grant_record.consumed_at<=NEW.created_at
      AND grant_record.consumed_at<grant_record.expires_at AND owner.wallet_id=agent.owner_wallet_id AND (NEW.scope='payments:execute' OR NEW.proof_public_key IS NOT NULL)
      AND EXTRACT(EPOCH FROM NEW.expires_at-NEW.created_at)=trunc(EXTRACT(EPOCH FROM NEW.expires_at-NEW.created_at))
      AND grant_record.operation_fingerprint=encode(sha256(convert_to(
        CASE WHEN NEW.rotated_from_credential_id IS NOT NULL THEN '["rail:owner-operation:v3","agent_credential_rotate","' || NEW.agent_id::text || '","' || NEW.rotated_from_credential_id::text || '","' || NEW.scope || '",' || EXTRACT(EPOCH FROM NEW.expires_at-NEW.created_at)::bigint::text || ',"' || NEW.proof_key_thumbprint || '"]'
        WHEN NEW.proof_public_key IS NULL THEN '["rail:owner-operation:v1","agent_credential","' || NEW.agent_id::text || '","' || NEW.scope || '",' || EXTRACT(EPOCH FROM NEW.expires_at-NEW.created_at)::bigint::text || ']'
        ELSE '["rail:owner-operation:v2","agent_credential","' || NEW.agent_id::text || '","' || NEW.scope || '",' || EXTRACT(EPOCH FROM NEW.expires_at-NEW.created_at)::bigint::text || ',"' || NEW.proof_key_thumbprint || '"]' END, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'agent_credential_step_up_binding_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_agent_credential_step_up ON rail_agent_credentials;
CREATE CONSTRAINT TRIGGER rail_agent_credential_step_up AFTER INSERT ON rail_agent_credentials
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_credential_step_up();
CREATE INDEX IF NOT EXISTS idx_agent_credentials_agent ON rail_agent_credentials(agent_id);
CREATE TABLE IF NOT EXISTS rail_agent_proof_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  credential_id UUID NOT NULL REFERENCES rail_agent_credentials(credential_id),
  key_thumbprint TEXT NOT NULL CHECK (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at = created_at + interval '60 seconds'),
  consumed_at TIMESTAMPTZ,
  proof_id TEXT CHECK (proof_id ~ '^[A-Za-z0-9_-]{43}$'),
  CHECK ((consumed_at IS NULL AND proof_id IS NULL) OR (consumed_at >= created_at AND consumed_at < expires_at AND proof_id IS NOT NULL)),
  UNIQUE (credential_id, proof_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_proof_nonces_credential ON rail_agent_proof_nonces(credential_id, expires_at);
ALTER TABLE rail_agent_proof_nonces ADD COLUMN IF NOT EXISTS proof_expires_at TIMESTAMPTZ;
ALTER TABLE rail_agent_proof_nonces ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE rail_agent_proof_nonces DROP CONSTRAINT IF EXISTS rail_agent_proof_dispatch_time;
ALTER TABLE rail_agent_proof_nonces ADD CONSTRAINT rail_agent_proof_dispatch_time CHECK (
  dispatched_at IS NULL OR (consumed_at IS NOT NULL AND proof_expires_at IS NOT NULL
    AND dispatched_at>=consumed_at AND dispatched_at<expires_at AND dispatched_at<proof_expires_at));
CREATE OR REPLACE FUNCTION rail_protect_agent_nonce() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'active_agent_nonce_is_immutable' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.nonce_hash,NEW.credential_id,NEW.key_thumbprint,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.nonce_hash,OLD.credential_id,OLD.key_thumbprint,OLD.created_at,OLD.expires_at)
    OR NEW.consumed_at IS NULL OR NEW.proof_id IS NULL OR NEW.proof_expires_at IS NULL
    OR (OLD.consumed_at IS NULL AND NEW.dispatched_at IS NOT NULL)
    OR (OLD.consumed_at IS NOT NULL AND (
      ROW(NEW.consumed_at,NEW.proof_id,NEW.proof_expires_at) IS DISTINCT FROM ROW(OLD.consumed_at,OLD.proof_id,OLD.proof_expires_at)
      OR OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NULL))) THEN
    RAISE EXCEPTION 'agent_nonce_is_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (NEW.consumed_at IS NOT NULL OR NEW.proof_id IS NOT NULL OR NEW.proof_expires_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM rail_agent_credentials WHERE credential_id=NEW.credential_id
      AND proof_key_thumbprint=NEW.key_thumbprint AND revoked_at IS NULL AND expires_at>NEW.created_at)) THEN
    RAISE EXCEPTION 'agent_nonce_credential_binding_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_agent_nonce_immutable ON rail_agent_proof_nonces;
CREATE TRIGGER rail_agent_nonce_immutable BEFORE INSERT OR UPDATE OR DELETE ON rail_agent_proof_nonces
  FOR EACH ROW EXECUTE FUNCTION rail_protect_agent_nonce();
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
ALTER TABLE rail_agent_mandates ADD COLUMN IF NOT EXISTS consent_receipt_version SMALLINT CHECK (consent_receipt_version IS NULL OR consent_receipt_version = 1);
ALTER TABLE rail_agent_mandates ALTER COLUMN consent_receipt_version SET DEFAULT 1;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS owner_evidence_version SMALLINT CHECK (owner_evidence_version IS NULL OR owner_evidence_version = 1);
ALTER TABLE rail_agent_intents ALTER COLUMN owner_evidence_version SET DEFAULT 1;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS owner_step_up_version SMALLINT CHECK (owner_step_up_version IS NULL OR owner_step_up_version=1);
ALTER TABLE rail_agent_mandates ADD COLUMN IF NOT EXISTS owner_step_up_challenge_id UUID REFERENCES rail_owner_step_up_grants(challenge_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mandate_owner_grant ON rail_agent_mandates(owner_step_up_challenge_id) WHERE owner_step_up_challenge_id IS NOT NULL;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS checkout JSONB;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS merchant_attestation JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='rail_agent_intents'::regclass AND conname='rail_agent_merchant_attestation_shape') THEN
    ALTER TABLE rail_agent_intents ADD CONSTRAINT rail_agent_merchant_attestation_shape CHECK (merchant_attestation IS NULL OR COALESCE(
      checkout IS NOT NULL AND jsonb_typeof(merchant_attestation) = 'object' AND
      merchant_attestation ?& ARRAY['version','keyId','signature','publicKey','keyFingerprint'] AND
      merchant_attestation - ARRAY['version','keyId','signature','publicKey','keyFingerprint'] = '{}'::jsonb AND
      merchant_attestation->'version' = '1'::jsonb AND jsonb_typeof(merchant_attestation->'keyId') = 'string' AND
      length(merchant_attestation->>'keyId') BETWEEN 3 AND 80 AND jsonb_typeof(merchant_attestation->'signature') = 'string' AND
      length(merchant_attestation->>'signature') = 88 AND jsonb_typeof(merchant_attestation->'publicKey') = 'string' AND
      length(merchant_attestation->>'publicKey') = 60 AND jsonb_typeof(merchant_attestation->'keyFingerprint') = 'string' AND
      merchant_attestation->>'keyFingerprint' ~ '^[a-f0-9]{64}$', FALSE));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_signed_quote_single_use
  ON rail_agent_intents(receiver_wallet_id, (checkout->>'quoteId')) WHERE merchant_attestation IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='rail_agent_intents'::regclass AND conname='rail_agent_checkout_binding') THEN
    ALTER TABLE rail_agent_intents ADD CONSTRAINT rail_agent_checkout_binding CHECK (checkout IS NULL OR COALESCE(
      jsonb_typeof(checkout) = 'object' AND
      checkout ?& ARRAY['version','merchantWalletId','quoteId','quoteVersion','subtotalMinor','feeMinor','totalMinor','currency','expiresAt','fundingSource'] AND
      checkout - ARRAY['version','merchantWalletId','quoteId','quoteVersion','subtotalMinor','feeMinor','totalMinor','currency','expiresAt','fundingSource'] = '{}'::jsonb AND
      checkout->'version' = '1'::jsonb AND jsonb_typeof(checkout->'merchantWalletId') = 'string' AND checkout->>'merchantWalletId' = receiver_wallet_id AND
      jsonb_typeof(checkout->'quoteId') = 'string' AND length(checkout->>'quoteId') BETWEEN 3 AND 128 AND
      jsonb_typeof(checkout->'quoteVersion') = 'number' AND (checkout->>'quoteVersion')::numeric BETWEEN 1 AND 1000000 AND
      (checkout->>'quoteVersion')::numeric = trunc((checkout->>'quoteVersion')::numeric) AND
      jsonb_typeof(checkout->'subtotalMinor') = 'number' AND (checkout->>'subtotalMinor')::numeric BETWEEN 1 AND 1000000000000 AND
      (checkout->>'subtotalMinor')::numeric = trunc((checkout->>'subtotalMinor')::numeric) AND
      jsonb_typeof(checkout->'feeMinor') = 'number' AND (checkout->>'feeMinor')::numeric BETWEEN 0 AND 1000000000000 AND
      (checkout->>'feeMinor')::numeric = trunc((checkout->>'feeMinor')::numeric) AND
      jsonb_typeof(checkout->'totalMinor') = 'number' AND (checkout->>'totalMinor')::numeric = amount_minor AND
      (checkout->>'subtotalMinor')::numeric + (checkout->>'feeMinor')::numeric = amount_minor AND
      jsonb_typeof(checkout->'currency') = 'string' AND checkout->>'currency' = currency AND
      jsonb_typeof(checkout->'expiresAt') = 'string' AND checkout->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND
      (checkout->>'expiresAt')::timestamptz >= expires_at AND
      jsonb_typeof(checkout->'fundingSource') = 'object' AND (checkout->'fundingSource') ?& ARRAY['type','walletId'] AND
      (checkout->'fundingSource') - ARRAY['type','walletId'] = '{}'::jsonb AND
      checkout->'fundingSource'->>'type' = 'internal_wallet' AND jsonb_typeof(checkout->'fundingSource'->'walletId') = 'string' AND
      checkout->'fundingSource'->>'walletId' = owner_wallet_id, FALSE));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS rail_agent_evidence_nonces (
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'), nonce TEXT NOT NULL,
  PRIMARY KEY (key_fingerprint, nonce)
);
CREATE TABLE IF NOT EXISTS rail_agent_owner_evidence (
  subject_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('agent-mandate-v1','agent-approval-v1','agent-rejection-v1')),
  mandate_id UUID NOT NULL REFERENCES rail_agent_mandates(mandate_id),
  intent_id UUID REFERENCES rail_agent_intents(intent_id),
  recorded_at TIMESTAMPTZ NOT NULL,
  key_fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  envelope JSONB NOT NULL,
  commitment TEXT NOT NULL CHECK (commitment ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (subject_id, purpose),
  UNIQUE (key_fingerprint, nonce),
  FOREIGN KEY (key_fingerprint, nonce) REFERENCES rail_agent_evidence_nonces(key_fingerprint, nonce),
  CHECK ((purpose = 'agent-mandate-v1' AND intent_id IS NULL AND subject_id = mandate_id) OR
    (purpose IN ('agent-approval-v1','agent-rejection-v1') AND intent_id IS NOT NULL AND subject_id = intent_id)),
  CHECK (COALESCE(jsonb_typeof(envelope) = 'object' AND envelope->>'purpose' = purpose AND envelope->>'txId' = subject_id::text
    AND envelope->>'nonce' = nonce AND envelope->>'version' = '1', FALSE))
);
ALTER TABLE rail_agent_owner_evidence ADD COLUMN IF NOT EXISTS step_up_challenge_id UUID REFERENCES rail_owner_step_up_grants(challenge_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_owner_evidence_grant ON rail_agent_owner_evidence(step_up_challenge_id) WHERE step_up_challenge_id IS NOT NULL;
-- Existing intents remain legacy records; newly created intents require authority receipts.
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS authority_receipt_version SMALLINT
  CHECK (authority_receipt_version IS NULL OR authority_receipt_version = 1);
ALTER TABLE rail_agent_intents ALTER COLUMN authority_receipt_version SET DEFAULT 1;
CREATE TABLE IF NOT EXISTS rail_agent_evidence_key_usage (
  key_fingerprint TEXT PRIMARY KEY CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  record_count BIGINT NOT NULL CHECK (record_count BETWEEN 1 AND 1000000)
);
CREATE TABLE IF NOT EXISTS rail_agent_authority_evidence (
  intent_id UUID PRIMARY KEY REFERENCES rail_agent_intents(intent_id),
  tx_id TEXT NOT NULL UNIQUE REFERENCES rail_payment_executions(tx_id) DEFERRABLE INITIALLY DEFERRED,
  credential_id UUID NOT NULL REFERENCES rail_agent_credentials(credential_id),
  payment_fingerprint TEXT NOT NULL CHECK (payment_fingerprint ~ '^[a-f0-9]{64}$'),
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  nonce TEXT NOT NULL,
  envelope JSONB NOT NULL,
  commitment TEXT NOT NULL CHECK (commitment ~ '^[a-f0-9]{64}$'),
  UNIQUE (key_fingerprint, nonce),
  CHECK (COALESCE(jsonb_typeof(envelope) = 'object' AND envelope ?& ARRAY['version','purpose','keyId','txId','requestFingerprint','payloadHash','nonce','ciphertext','tag','mac']
    AND envelope->>'version' = '1' AND envelope->>'purpose' = 'agent-authority-v1'
    AND envelope->>'txId' = tx_id AND envelope->>'nonce' = nonce, FALSE))
);
INSERT INTO rail_agent_evidence_nonces(key_fingerprint, nonce)
  SELECT key_fingerprint, nonce FROM rail_agent_authority_evidence ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION rail_check_agent_owner_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'rail_agent_mandates' THEN
    IF NEW.owner_step_up_challenge_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM rail_owner_step_up_grants grant_record JOIN users owner ON owner.user_id=grant_record.user_id
        JOIN rail_agent_owner_evidence consent ON consent.mandate_id=NEW.mandate_id AND consent.purpose='agent-mandate-v1'
      WHERE grant_record.challenge_id=NEW.owner_step_up_challenge_id AND consent.step_up_challenge_id=grant_record.challenge_id
        AND grant_record.operation='agent_mandate' AND grant_record.consumed_at IS NOT NULL
        AND grant_record.consumed_at<=NEW.created_at AND grant_record.consumed_at<grant_record.expires_at
        AND owner.wallet_id=NEW.owner_wallet_id) THEN
      RAISE EXCEPTION 'agent_mandate_step_up_binding_invalid' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM rail_agent_mandates mandate WHERE mandate.mandate_id=NEW.mandate_id
      AND mandate.consent_receipt_version=1 AND NOT EXISTS (SELECT 1 FROM rail_agent_owner_evidence evidence
        WHERE evidence.mandate_id=mandate.mandate_id AND evidence.purpose='agent-mandate-v1')) THEN
      RAISE EXCEPTION 'agent_mandate_consent_required' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM rail_agent_intents intent JOIN rail_agent_mandates mandate ON mandate.mandate_id=intent.mandate_id
      WHERE intent.intent_id=NEW.intent_id AND intent.owner_step_up_version=1 AND (mandate.owner_step_up_challenge_id IS NULL OR
        (intent.status IN ('approved','executed') AND mandate.mode='approval_required' AND NOT EXISTS (
          SELECT 1 FROM rail_agent_owner_evidence approval JOIN rail_owner_step_up_grants grant_record ON grant_record.challenge_id=approval.step_up_challenge_id
          JOIN users owner ON owner.user_id=grant_record.user_id
          WHERE approval.intent_id=intent.intent_id AND approval.purpose='agent-approval-v1' AND approval.mandate_id=intent.mandate_id
            AND owner.wallet_id=intent.owner_wallet_id AND grant_record.operation='agent_approval'
            AND grant_record.consumed_at IS NOT NULL AND grant_record.consumed_at<=approval.recorded_at
            AND grant_record.consumed_at<grant_record.expires_at
            AND grant_record.operation_fingerprint=encode(sha256(convert_to('["rail:owner-operation:v1","agent_approval","' || intent.agent_id::text || '","' || intent.intent_id::text || '","' || intent.request_fingerprint || '"]', 'UTF8')), 'hex'))))) THEN
      RAISE EXCEPTION 'agent_intent_step_up_binding_invalid' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM rail_agent_intents intent JOIN rail_agent_mandates mandate ON mandate.mandate_id=intent.mandate_id
      WHERE intent.intent_id=NEW.intent_id AND intent.owner_evidence_version=1 AND
        ((intent.status IN ('approved','executed') AND (mandate.consent_receipt_version IS DISTINCT FROM 1 OR NOT EXISTS
          (SELECT 1 FROM rail_agent_owner_evidence consent WHERE consent.mandate_id=mandate.mandate_id AND consent.purpose='agent-mandate-v1')))
        OR (intent.status IN ('approved','executed') AND mandate.mode='approval_required' AND NOT EXISTS
          (SELECT 1 FROM rail_agent_owner_evidence approval WHERE approval.intent_id=intent.intent_id AND approval.mandate_id=intent.mandate_id AND approval.purpose='agent-approval-v1'))
        OR (intent.status='rejected' AND intent.terminal_reason='owner_rejected' AND NOT EXISTS
          (SELECT 1 FROM rail_agent_owner_evidence rejection WHERE rejection.intent_id=intent.intent_id AND rejection.mandate_id=intent.mandate_id AND rejection.purpose='agent-rejection-v1')))) THEN
      RAISE EXCEPTION 'agent_owner_decision_required' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='rail_agent_owner_evidence' THEN
      IF NEW.intent_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM rail_agent_intents intent WHERE intent.intent_id=NEW.intent_id AND intent.mandate_id=NEW.mandate_id
          AND NEW.recorded_at >= intent.created_at AND NEW.recorded_at < intent.expires_at) THEN
        RAISE EXCEPTION 'agent_owner_evidence_binding_invalid' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_agent_mandate_consent_check ON rail_agent_mandates;
CREATE CONSTRAINT TRIGGER rail_agent_mandate_consent_check AFTER INSERT OR UPDATE ON rail_agent_mandates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_owner_evidence();
DROP TRIGGER IF EXISTS rail_agent_intent_owner_check ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_agent_intent_owner_check AFTER INSERT OR UPDATE ON rail_agent_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_owner_evidence();
DROP TRIGGER IF EXISTS rail_agent_owner_evidence_binding_commit ON rail_agent_owner_evidence;
CREATE CONSTRAINT TRIGGER rail_agent_owner_evidence_binding_commit AFTER INSERT ON rail_agent_owner_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_owner_evidence();
CREATE OR REPLACE FUNCTION rail_check_agent_authority() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rail_agent_intents intent WHERE intent.intent_id = NEW.intent_id
      AND intent.status = 'executed' AND intent.authority_receipt_version = 1 AND NOT EXISTS (
        SELECT 1 FROM rail_agent_authority_evidence evidence
        JOIN rail_payment_executions execution ON execution.tx_id = evidence.tx_id
        JOIN rail_agent_credentials credential ON credential.credential_id = evidence.credential_id
        WHERE evidence.intent_id = intent.intent_id AND evidence.tx_id = intent.payment_tx_id
          AND evidence.payment_fingerprint = execution.request_fingerprint
          AND credential.agent_id = intent.agent_id AND credential.scope = 'payments:execute'
          AND intent.executed_at >= credential.created_at AND intent.executed_at < credential.expires_at))
    OR EXISTS (SELECT 1 FROM rail_agent_authority_evidence evidence
      JOIN rail_agent_intents intent ON intent.intent_id = evidence.intent_id
      JOIN rail_payment_executions execution ON execution.tx_id = evidence.tx_id
      JOIN rail_agent_credentials credential ON credential.credential_id = evidence.credential_id
      WHERE evidence.intent_id = NEW.intent_id AND (intent.status <> 'executed' OR intent.authority_receipt_version IS DISTINCT FROM 1
        OR intent.payment_tx_id IS DISTINCT FROM evidence.tx_id OR evidence.payment_fingerprint IS DISTINCT FROM execution.request_fingerprint
        OR credential.agent_id IS DISTINCT FROM intent.agent_id OR credential.scope <> 'payments:execute'
        OR intent.executed_at < credential.created_at OR intent.executed_at >= credential.expires_at)) THEN
    RAISE EXCEPTION 'agent_authority_evidence_missing_or_mismatched' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_agent_z_authority_check ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_agent_z_authority_check AFTER INSERT OR UPDATE ON rail_agent_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_authority();
DROP TRIGGER IF EXISTS rail_agent_evidence_commit_check ON rail_agent_authority_evidence;
CREATE CONSTRAINT TRIGGER rail_agent_evidence_commit_check AFTER INSERT ON rail_agent_authority_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_agent_authority();
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
        WHERE intent.mandate_id = id AND intent.status IN ('pending','approved')), 0)
        + COALESCE((SELECT sum((payment.binding->>'amountMinor')::bigint) FROM rail_provider_payments payment
          WHERE payment.mandate_id=id AND payment.authorization_required AND payment.status NOT IN ('succeeded','failed','cancelled')),0) OR
       mandate.spent_budget_minor <> COALESCE((SELECT SUM(intent.amount_minor) FROM rail_agent_intents intent
        WHERE intent.mandate_id = id AND intent.status = 'executed'), 0)
        + COALESCE((SELECT sum((payment.binding->>'amountMinor')::bigint) FROM rail_provider_payments payment
          WHERE payment.mandate_id=id AND payment.authorization_required AND payment.status='succeeded'),0))) THEN
    RAISE EXCEPTION 'agent_budget_reservation_mismatch' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION rail_protect_agent_control() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_control_history_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'rail_agents' THEN
    IF ROW(NEW.agent_id, NEW.owner_wallet_id, NEW.name, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.agent_id, OLD.owner_wallet_id, OLD.name, OLD.created_at)
      OR (OLD.status = 'revoked' AND NEW.status <> 'revoked') THEN
      RAISE EXCEPTION 'agent_identity_is_immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'rail_agent_credentials' THEN
    IF ROW(NEW.credential_id, NEW.agent_id, NEW.token_hash, NEW.scope, NEW.created_at, NEW.expires_at, NEW.owner_step_up_challenge_id, NEW.proof_public_key, NEW.proof_key_thumbprint, NEW.rotated_from_credential_id)
      IS DISTINCT FROM ROW(OLD.credential_id, OLD.agent_id, OLD.token_hash, OLD.scope, OLD.created_at, OLD.expires_at, OLD.owner_step_up_challenge_id, OLD.proof_public_key, OLD.proof_key_thumbprint, OLD.rotated_from_credential_id) THEN
      RAISE EXCEPTION 'agent_credential_is_immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'rail_agent_mandates' THEN
    IF ROW(NEW.mandate_id, NEW.agent_id, NEW.owner_wallet_id, NEW.mode, NEW.currency,
        NEW.per_payment_limit_minor, NEW.total_budget_minor, NEW.allowed_receiver_wallet_ids, NEW.created_at, NEW.expires_at, NEW.consent_receipt_version, NEW.owner_step_up_challenge_id)
      IS DISTINCT FROM ROW(OLD.mandate_id, OLD.agent_id, OLD.owner_wallet_id, OLD.mode, OLD.currency,
        OLD.per_payment_limit_minor, OLD.total_budget_minor, OLD.allowed_receiver_wallet_ids, OLD.created_at, OLD.expires_at, OLD.consent_receipt_version, OLD.owner_step_up_challenge_id) THEN
      RAISE EXCEPTION 'agent_mandate_policy_is_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'agent_revocation_is_permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_agent_control_immutable ON rail_agents;
CREATE TRIGGER rail_agent_control_immutable BEFORE UPDATE OR DELETE ON rail_agents
  FOR EACH ROW EXECUTE FUNCTION rail_protect_agent_control();
DROP TRIGGER IF EXISTS rail_agent_credential_immutable ON rail_agent_credentials;
CREATE TRIGGER rail_agent_credential_immutable BEFORE UPDATE OR DELETE ON rail_agent_credentials
  FOR EACH ROW EXECUTE FUNCTION rail_protect_agent_control();
DROP TRIGGER IF EXISTS rail_agent_mandate_immutable ON rail_agent_mandates;
CREATE TRIGGER rail_agent_mandate_immutable BEFORE UPDATE OR DELETE ON rail_agent_mandates
  FOR EACH ROW EXECUTE FUNCTION rail_protect_agent_control();
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
      NEW.proposal_fingerprint, NEW.request_fingerprint, NEW.receiver_wallet_id, NEW.amount_minor, NEW.currency, NEW.created_at, NEW.expires_at, NEW.authority_receipt_version, NEW.owner_evidence_version, NEW.checkout, NEW.merchant_attestation, NEW.owner_step_up_version)
    IS DISTINCT FROM ROW(OLD.intent_id, OLD.agent_id, OLD.mandate_id, OLD.owner_wallet_id, OLD.client_request_id,
      OLD.proposal_fingerprint, OLD.request_fingerprint, OLD.receiver_wallet_id, OLD.amount_minor, OLD.currency, OLD.created_at, OLD.expires_at, OLD.authority_receipt_version, OLD.owner_evidence_version, OLD.checkout, OLD.merchant_attestation, OLD.owner_step_up_version)
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
  IF EXISTS (SELECT 1 FROM rail_payment_executions execution WHERE execution.tx_id = payment_tx_id AND execution.evidence_required
      AND NOT EXISTS (SELECT 1 FROM rail_audit_pending pending WHERE pending.tx_id = execution.tx_id)
      AND NOT EXISTS (SELECT 1 FROM rail_audit_memberships membership WHERE membership.tx_id = execution.tx_id)) THEN
    RAISE EXCEPTION 'payment_audit_queue_missing' USING ERRCODE = '23514';
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
DROP TRIGGER IF EXISTS rail_agent_evidence_immutable ON rail_agent_authority_evidence;
CREATE TRIGGER rail_agent_evidence_immutable BEFORE UPDATE OR DELETE ON rail_agent_authority_evidence
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_agent_owner_evidence_immutable ON rail_agent_owner_evidence;
CREATE TRIGGER rail_agent_owner_evidence_immutable BEFORE UPDATE OR DELETE ON rail_agent_owner_evidence
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_agent_nonce_immutable ON rail_agent_evidence_nonces;
CREATE TRIGGER rail_agent_nonce_immutable BEFORE UPDATE OR DELETE ON rail_agent_evidence_nonces
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_owner_passkey_no_delete ON rail_owner_passkeys;
CREATE TRIGGER rail_owner_passkey_no_delete BEFORE DELETE ON rail_owner_passkeys
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_audit_batch_immutable ON rail_audit_batches;
CREATE TRIGGER rail_audit_batch_immutable BEFORE UPDATE OR DELETE ON rail_audit_batches
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
DROP TRIGGER IF EXISTS rail_audit_membership_immutable ON rail_audit_memberships;
CREATE TRIGGER rail_audit_membership_immutable BEFORE UPDATE OR DELETE ON rail_audit_memberships
  FOR EACH ROW EXECUTE FUNCTION rail_reject_history_mutation();
CREATE OR REPLACE FUNCTION rail_queue_audit_evidence() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO rail_audit_pending(tx_id) SELECT NEW.tx_id FROM rail_payment_executions execution
    WHERE execution.tx_id = NEW.tx_id AND execution.evidence_required ON CONFLICT (tx_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_queue_audit_evidence ON rail_transaction_evidence;
CREATE TRIGGER rail_queue_audit_evidence AFTER INSERT ON rail_transaction_evidence FOR EACH ROW EXECUTE FUNCTION rail_queue_audit_evidence();
CREATE OR REPLACE FUNCTION rail_guard_audit_pending() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM rail_audit_memberships WHERE tx_id = OLD.tx_id)) THEN
    RAISE EXCEPTION 'audit_queue_requires_membership' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS rail_guard_audit_pending ON rail_audit_pending;
CREATE TRIGGER rail_guard_audit_pending BEFORE UPDATE OR DELETE ON rail_audit_pending FOR EACH ROW EXECUTE FUNCTION rail_guard_audit_pending();
CREATE OR REPLACE FUNCTION rail_check_audit_pending() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rail_audit_pending pending WHERE pending.tx_id = NEW.tx_id AND
      (EXISTS (SELECT 1 FROM rail_audit_memberships membership WHERE membership.tx_id = pending.tx_id) OR
       NOT EXISTS (SELECT 1 FROM rail_payment_executions execution WHERE execution.tx_id = pending.tx_id AND execution.evidence_required))) THEN
    RAISE EXCEPTION 'audit_pending_state_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_check_audit_pending ON rail_audit_pending;
CREATE CONSTRAINT TRIGGER rail_check_audit_pending AFTER INSERT ON rail_audit_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_audit_pending();
CREATE OR REPLACE FUNCTION rail_check_audit_batch() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE expected INTEGER;
BEGIN
  SELECT leaf_count INTO expected FROM rail_audit_batches WHERE batch_id = NEW.batch_id;
  IF expected IS NULL OR (SELECT COUNT(*) FROM rail_audit_memberships WHERE batch_id = NEW.batch_id) <> expected
    OR EXISTS (SELECT 1 FROM rail_audit_memberships membership JOIN rail_payment_executions execution ON execution.tx_id = membership.tx_id
      WHERE membership.batch_id = NEW.batch_id AND (membership.leaf_index >= expected OR (membership.proof->>'leafCount')::integer <> expected
        OR NOT execution.evidence_required OR execution.risk_protection_required <> (membership.risk_commitment IS NOT NULL)
        OR EXISTS (SELECT 1 FROM rail_audit_pending pending WHERE pending.tx_id = membership.tx_id))) THEN
    RAISE EXCEPTION 'audit_batch_incomplete_or_unbound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_check_audit_batch ON rail_audit_batches;
CREATE CONSTRAINT TRIGGER rail_check_audit_batch AFTER INSERT ON rail_audit_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_audit_batch();
DROP TRIGGER IF EXISTS rail_check_audit_member ON rail_audit_memberships;
CREATE CONSTRAINT TRIGGER rail_check_audit_member AFTER INSERT ON rail_audit_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_audit_batch();
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

ALTER TABLE rail_owner_challenges DROP CONSTRAINT IF EXISTS rail_owner_challenges_operation_check;
ALTER TABLE rail_owner_challenges ADD CONSTRAINT rail_owner_challenges_operation_check
  CHECK(operation IN ('agent_credential','agent_mandate','agent_approval','passkey_enroll','passkey_revoke','recovery_codes','shared_budget','provider_payment'));
ALTER TABLE rail_owner_step_up_grants DROP CONSTRAINT IF EXISTS rail_owner_step_up_grants_operation_check;
ALTER TABLE rail_owner_step_up_grants ADD CONSTRAINT rail_owner_step_up_grants_operation_check
  CHECK(operation IN ('agent_credential','agent_mandate','agent_approval','passkey_enroll','passkey_revoke','recovery_codes','shared_budget','provider_payment'));

CREATE TABLE IF NOT EXISTS rail_shared_budgets (
  budget_id UUID PRIMARY KEY, owner_wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), currency TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  total_budget_minor BIGINT NOT NULL CHECK(total_budget_minor BETWEEN 1 AND 1000000000000),
  reserved_budget_minor BIGINT NOT NULL DEFAULT 0 CHECK(reserved_budget_minor>=0),
  spent_budget_minor BIGINT NOT NULL DEFAULT 0 CHECK(spent_budget_minor>=0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ, created_control_id UUID NOT NULL, current_control_id UUID NOT NULL, revoked_control_id UUID,
  UNIQUE(budget_id,owner_wallet_id), CHECK(reserved_budget_minor+spent_budget_minor<=total_budget_minor),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
  CHECK((revoked_at IS NULL)=(revoked_control_id IS NULL)), CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX IF NOT EXISTS idx_shared_budgets_owner ON rail_shared_budgets(owner_wallet_id,created_at,budget_id);
CREATE TABLE IF NOT EXISTS rail_shared_budget_controls (
  control_id UUID PRIMARY KEY, budget_id UUID NOT NULL, owner_wallet_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','limit','member_add','member_remove','revoke')),
  canonical_payload TEXT NOT NULL CHECK(octet_length(canonical_payload) BETWEEN 10 AND 8192),
  operation_fingerprint TEXT NOT NULL CHECK(operation_fingerprint=encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')),
  step_up_challenge_id UUID UNIQUE REFERENCES rail_owner_step_up_grants(challenge_id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(budget_id,owner_wallet_id) REFERENCES rail_shared_budgets(budget_id,owner_wallet_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(control_id,budget_id,owner_wallet_id),
  CHECK(jsonb_typeof(canonical_payload::jsonb)='array' AND jsonb_array_length(canonical_payload::jsonb)=5),
  CHECK(COALESCE(canonical_payload::jsonb->>0='rail:owner-operation:v1' AND canonical_payload::jsonb->>1='shared_budget'
    AND canonical_payload::jsonb->>2=action AND (CASE WHEN action='create' THEN canonical_payload::jsonb->3='null'::jsonb
      ELSE canonical_payload::jsonb->>3=budget_id::text END),false))
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='rail_shared_budgets'::regclass AND conname='shared_budget_creation_control') THEN
    ALTER TABLE rail_shared_budgets ADD CONSTRAINT shared_budget_creation_control FOREIGN KEY(created_control_id,budget_id,owner_wallet_id)
      REFERENCES rail_shared_budget_controls(control_id,budget_id,owner_wallet_id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE rail_shared_budgets ADD CONSTRAINT shared_budget_current_control FOREIGN KEY(current_control_id,budget_id,owner_wallet_id)
      REFERENCES rail_shared_budget_controls(control_id,budget_id,owner_wallet_id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE rail_shared_budgets ADD CONSTRAINT shared_budget_revocation_control FOREIGN KEY(revoked_control_id,budget_id,owner_wallet_id)
      REFERENCES rail_shared_budget_controls(control_id,budget_id,owner_wallet_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS rail_shared_budget_members (
  budget_id UUID NOT NULL, agent_id UUID NOT NULL, owner_wallet_id TEXT NOT NULL,
  created_control_id UUID NOT NULL, revoked_control_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
  PRIMARY KEY(budget_id,agent_id,owner_wallet_id),
  FOREIGN KEY(budget_id,owner_wallet_id) REFERENCES rail_shared_budgets(budget_id,owner_wallet_id),
  FOREIGN KEY(agent_id,owner_wallet_id) REFERENCES rail_agents(agent_id,owner_wallet_id),
  FOREIGN KEY(created_control_id,budget_id,owner_wallet_id) REFERENCES rail_shared_budget_controls(control_id,budget_id,owner_wallet_id),
  FOREIGN KEY(revoked_control_id,budget_id,owner_wallet_id) REFERENCES rail_shared_budget_controls(control_id,budget_id,owner_wallet_id),
  CHECK((revoked_at IS NULL)=(revoked_control_id IS NULL)), CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
ALTER TABLE rail_agent_mandates ADD COLUMN IF NOT EXISTS shared_budget_id UUID;
ALTER TABLE rail_agent_intents ADD COLUMN IF NOT EXISTS shared_budget_id UUID;
ALTER TABLE rail_agent_intents DROP CONSTRAINT IF EXISTS rail_agent_intents_terminal_reason_check;
ALTER TABLE rail_agent_intents ADD CONSTRAINT rail_agent_intents_terminal_reason_check
  CHECK(terminal_reason IN ('owner_rejected','agent_revoked','mandate_revoked','deadline_expired','shared_budget_revoked','shared_budget_membership_revoked'));
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='rail_agent_mandates'::regclass AND conname='agent_shared_budget_membership') THEN
    ALTER TABLE rail_agent_mandates ADD CONSTRAINT agent_shared_budget_membership FOREIGN KEY(shared_budget_id,agent_id,owner_wallet_id)
      REFERENCES rail_shared_budget_members(budget_id,agent_id,owner_wallet_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_agent_mandate_shared_budget ON rail_agent_mandates(shared_budget_id,agent_id) WHERE shared_budget_id IS NOT NULL;

CREATE OR REPLACE FUNCTION rail_protect_shared_budget_history() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='rail_shared_budget_controls' THEN
    RAISE EXCEPTION 'shared_budget_history_is_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME IN ('rail_agent_mandates','rail_agent_intents') THEN
    IF NEW.shared_budget_id IS DISTINCT FROM OLD.shared_budget_id THEN
      RAISE EXCEPTION 'shared_budget_binding_is_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='rail_shared_budgets' THEN
    IF ROW(NEW.budget_id,NEW.owner_wallet_id,NEW.name,NEW.currency,NEW.created_at,NEW.expires_at,NEW.created_control_id)
      IS DISTINCT FROM ROW(OLD.budget_id,OLD.owner_wallet_id,OLD.name,OLD.currency,OLD.created_at,OLD.expires_at,OLD.created_control_id)
      OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at,NEW.revoked_control_id,NEW.total_budget_minor,NEW.revision,NEW.current_control_id)
        IS DISTINCT FROM ROW(OLD.revoked_at,OLD.revoked_control_id,OLD.total_budget_minor,OLD.revision,OLD.current_control_id)) THEN
      RAISE EXCEPTION 'shared_budget_policy_is_immutable' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.total_budget_minor,NEW.revision,NEW.current_control_id) IS DISTINCT FROM ROW(OLD.total_budget_minor,OLD.revision,OLD.current_control_id)
      AND (NEW.revision<>OLD.revision+1 OR NEW.current_control_id=OLD.current_control_id) THEN
      RAISE EXCEPTION 'shared_budget_revision_invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.budget_id,NEW.agent_id,NEW.owner_wallet_id,NEW.created_at,NEW.created_control_id)
      IS DISTINCT FROM ROW(OLD.budget_id,OLD.agent_id,OLD.owner_wallet_id,OLD.created_at,OLD.created_control_id)
      OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at,NEW.revoked_control_id) IS DISTINCT FROM ROW(OLD.revoked_at,OLD.revoked_control_id)) THEN
      RAISE EXCEPTION 'shared_budget_membership_is_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_shared_control_immutable ON rail_shared_budget_controls;
CREATE TRIGGER rail_shared_control_immutable BEFORE UPDATE OR DELETE ON rail_shared_budget_controls FOR EACH ROW EXECUTE FUNCTION rail_protect_shared_budget_history();
DROP TRIGGER IF EXISTS rail_shared_budget_immutable ON rail_shared_budgets;
CREATE TRIGGER rail_shared_budget_immutable BEFORE UPDATE OR DELETE ON rail_shared_budgets FOR EACH ROW EXECUTE FUNCTION rail_protect_shared_budget_history();
DROP TRIGGER IF EXISTS rail_shared_member_immutable ON rail_shared_budget_members;
CREATE TRIGGER rail_shared_member_immutable BEFORE UPDATE OR DELETE ON rail_shared_budget_members FOR EACH ROW EXECUTE FUNCTION rail_protect_shared_budget_history();
DROP TRIGGER IF EXISTS rail_shared_mandate_binding ON rail_agent_mandates;
CREATE TRIGGER rail_shared_mandate_binding BEFORE UPDATE ON rail_agent_mandates FOR EACH ROW EXECUTE FUNCTION rail_protect_shared_budget_history();
DROP TRIGGER IF EXISTS rail_shared_intent_binding ON rail_agent_intents;
CREATE TRIGGER rail_shared_intent_binding BEFORE UPDATE ON rail_agent_intents FOR EACH ROW EXECUTE FUNCTION rail_protect_shared_budget_history();

CREATE OR REPLACE FUNCTION rail_check_shared_budget_control() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE terms JSONB; policy rail_shared_budgets%ROWTYPE; control rail_shared_budget_controls%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='rail_shared_budget_controls' THEN
    IF NEW.step_up_challenge_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM rail_owner_step_up_grants grant_record JOIN users owner ON owner.user_id=grant_record.user_id
      WHERE grant_record.challenge_id=NEW.step_up_challenge_id AND owner.wallet_id=NEW.owner_wallet_id
        AND grant_record.operation='shared_budget' AND grant_record.operation_fingerprint=NEW.operation_fingerprint
        AND grant_record.consumed_at IS NOT NULL AND grant_record.consumed_at<=NEW.recorded_at
        AND grant_record.consumed_at<grant_record.expires_at) THEN
      RAISE EXCEPTION 'shared_budget_step_up_binding_invalid' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='rail_shared_budgets' THEN
    SELECT * INTO policy FROM rail_shared_budgets WHERE budget_id=NEW.budget_id;
    SELECT * INTO control FROM rail_shared_budget_controls WHERE control_id=policy.created_control_id;
    terms:=control.canonical_payload::jsonb->4;
    IF control.action IS DISTINCT FROM 'create' OR terms->>0 IS DISTINCT FROM policy.name OR terms->>1 IS DISTINCT FROM policy.currency
      OR terms->4 IS DISTINCT FROM (SELECT jsonb_agg(agent_id::text ORDER BY agent_id) FROM rail_shared_budget_members
        WHERE budget_id=policy.budget_id AND created_control_id=policy.created_control_id)
      OR (terms->>3)::integer IS DISTINCT FROM extract(epoch FROM policy.expires_at-policy.created_at)::integer THEN
      RAISE EXCEPTION 'shared_budget_creation_binding_invalid' USING ERRCODE='23514';
    END IF;
    SELECT * INTO control FROM rail_shared_budget_controls WHERE control_id=policy.current_control_id;
    terms:=control.canonical_payload::jsonb->4;
    IF (policy.revision=1 AND (control.action IS DISTINCT FROM 'create' OR (terms->>2)::bigint IS DISTINCT FROM policy.total_budget_minor))
      OR (policy.revision>1 AND (control.action IS DISTINCT FROM 'limit' OR (terms->>0)::integer IS DISTINCT FROM policy.revision-1
        OR (terms->>1)::bigint IS DISTINCT FROM policy.total_budget_minor)) THEN
      RAISE EXCEPTION 'shared_budget_limit_binding_invalid' USING ERRCODE='23514';
    END IF;
    IF policy.revoked_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rail_shared_budget_controls
      WHERE control_id=policy.revoked_control_id AND action='revoke' AND recorded_at<=policy.revoked_at) THEN
      RAISE EXCEPTION 'shared_budget_revocation_binding_invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO control FROM rail_shared_budget_controls WHERE control_id=NEW.created_control_id;
    terms:=control.canonical_payload::jsonb->4;
    IF NOT COALESCE((control.action='create' AND terms->4 @> jsonb_build_array(NEW.agent_id::text))
      OR (control.action='member_add' AND terms=jsonb_build_array(NEW.agent_id::text)),false) THEN
      RAISE EXCEPTION 'shared_budget_membership_binding_invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rail_shared_budget_controls
      WHERE control_id=NEW.revoked_control_id AND action='member_remove' AND canonical_payload::jsonb->4=jsonb_build_array(NEW.agent_id::text)
        AND recorded_at<=NEW.revoked_at) THEN
      RAISE EXCEPTION 'shared_budget_member_revocation_invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_shared_control_binding ON rail_shared_budget_controls;
CREATE CONSTRAINT TRIGGER rail_shared_control_binding AFTER INSERT ON rail_shared_budget_controls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_shared_budget_control();
DROP TRIGGER IF EXISTS rail_shared_budget_binding ON rail_shared_budgets;
CREATE CONSTRAINT TRIGGER rail_shared_budget_binding AFTER INSERT OR UPDATE ON rail_shared_budgets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_shared_budget_control();
DROP TRIGGER IF EXISTS rail_shared_member_binding ON rail_shared_budget_members;
CREATE CONSTRAINT TRIGGER rail_shared_member_binding AFTER INSERT OR UPDATE ON rail_shared_budget_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_shared_budget_control();

CREATE OR REPLACE FUNCTION rail_account_shared_budget() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE id UUID; old_held BIGINT:=0; old_spent BIGINT:=0; new_held BIGINT:=0; new_spent BIGINT:=0;
BEGIN
  SELECT shared_budget_id INTO id FROM rail_agent_mandates WHERE mandate_id=NEW.mandate_id;
  IF NEW.shared_budget_id IS DISTINCT FROM id THEN RAISE EXCEPTION 'shared_budget_binding_invalid' USING ERRCODE='23514'; END IF;
  IF id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status IN ('pending','approved') THEN old_held:=OLD.amount_minor; END IF;
    IF OLD.status='executed' THEN old_spent:=OLD.amount_minor; END IF;
  END IF;
  IF NEW.status IN ('pending','approved') THEN new_held:=NEW.amount_minor; END IF;
  IF NEW.status='executed' THEN new_spent:=NEW.amount_minor; END IF;
  IF new_held=old_held AND new_spent=old_spent THEN RETURN NULL; END IF;
  UPDATE rail_shared_budgets SET reserved_budget_minor=reserved_budget_minor+new_held-old_held,
    spent_budget_minor=spent_budget_minor+new_spent-old_spent
    WHERE budget_id=id AND owner_wallet_id=NEW.owner_wallet_id AND currency=NEW.currency
      AND reserved_budget_minor+new_held-old_held>=0 AND spent_budget_minor+new_spent-old_spent>=0
      AND reserved_budget_minor+new_held-old_held+spent_budget_minor+new_spent-old_spent<=total_budget_minor
      AND ((new_held<=old_held AND new_spent<=old_spent) OR (revoked_at IS NULL AND expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM rail_shared_budget_members member WHERE member.budget_id=id
          AND member.agent_id=NEW.agent_id AND member.owner_wallet_id=NEW.owner_wallet_id AND member.revoked_at IS NULL)));
  IF NOT FOUND THEN RAISE EXCEPTION 'shared_budget_unavailable' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_shared_intent_accounting ON rail_agent_intents;
CREATE TRIGGER rail_shared_intent_accounting AFTER INSERT OR UPDATE ON rail_agent_intents FOR EACH ROW EXECUTE FUNCTION rail_account_shared_budget();
CREATE OR REPLACE FUNCTION rail_check_shared_budget_totals() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE id UUID;
BEGIN
  IF TG_TABLE_NAME='rail_shared_budgets' THEN id:=NEW.budget_id;
  ELSE SELECT shared_budget_id INTO id FROM rail_agent_mandates WHERE mandate_id=NEW.mandate_id; END IF;
  IF id IS NOT NULL AND EXISTS(SELECT 1 FROM rail_shared_budgets budget WHERE budget.budget_id=id AND
    (budget.reserved_budget_minor<>COALESCE((SELECT sum(intent.amount_minor) FROM rail_agent_intents intent
      JOIN rail_agent_mandates mandate ON mandate.mandate_id=intent.mandate_id WHERE mandate.shared_budget_id=id AND intent.status IN ('pending','approved')),0)
      + COALESCE((SELECT sum((payment.binding->>'amountMinor')::bigint) FROM rail_provider_payments payment
        WHERE payment.shared_budget_id=id AND payment.authorization_required AND payment.status NOT IN ('succeeded','failed','cancelled')),0)
    OR budget.spent_budget_minor<>COALESCE((SELECT sum(intent.amount_minor) FROM rail_agent_intents intent
      JOIN rail_agent_mandates mandate ON mandate.mandate_id=intent.mandate_id WHERE mandate.shared_budget_id=id AND intent.status='executed'),0)
      + COALESCE((SELECT sum((payment.binding->>'amountMinor')::bigint) FROM rail_provider_payments payment
        WHERE payment.shared_budget_id=id AND payment.authorization_required AND payment.status='succeeded'),0))) THEN
    RAISE EXCEPTION 'shared_budget_accounting_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_shared_totals_check ON rail_shared_budgets;
CREATE CONSTRAINT TRIGGER rail_shared_totals_check AFTER INSERT OR UPDATE ON rail_shared_budgets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_shared_budget_totals();
DROP TRIGGER IF EXISTS rail_shared_intent_totals_check ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_shared_intent_totals_check AFTER INSERT OR UPDATE ON rail_agent_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_shared_budget_totals();

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mandate_provider_binding
  ON rail_agent_mandates(mandate_id,agent_id,owner_wallet_id,shared_budget_id);
CREATE TABLE IF NOT EXISTS rail_provider_payments (
  operation_id UUID PRIMARY KEY,
  owner_wallet_id TEXT NOT NULL,
  agent_id UUID NOT NULL,
  mandate_id UUID NOT NULL,
  shared_budget_id UUID NOT NULL,
  intent_id UUID NOT NULL UNIQUE,
  binding JSONB NOT NULL,
  fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(idempotency_key='rail_provider_v1_' || operation_id::text),
  status TEXT NOT NULL CHECK(status IN ('reserved','submitting','unknown','processing','requires_owner_action','succeeded','failed','cancelled')),
  provider_ref TEXT CHECK(provider_ref ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  first_submission_at_ms BIGINT,
  retry_window_ends_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  revision INTEGER NOT NULL CHECK(revision>0),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>=0 AND attempt_number<=revision),
  last_event TEXT NOT NULL CHECK(last_event IN ('created','begin_submission','retry_submission','submission_uncertain','cancel_before_submission','provider_observed')),
  authorization_required BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY(mandate_id,agent_id,owner_wallet_id,shared_budget_id)
    REFERENCES rail_agent_mandates(mandate_id,agent_id,owner_wallet_id,shared_budget_id),
  CHECK(COALESCE(jsonb_typeof(binding)='object' AND binding->'version'='1'::jsonb
    AND binding->>'operationId'=operation_id::text AND binding->>'ownerWalletId'=owner_wallet_id
    AND binding->>'agentId'=agent_id::text AND binding->>'mandateId'=mandate_id::text
    AND binding->>'sharedBudgetId'=shared_budget_id::text AND binding->>'intentId'=intent_id::text,FALSE)),
  CHECK(COALESCE((first_submission_at_ms IS NULL AND retry_window_ends_at_ms IS NULL AND attempt_number=0
      AND status IN ('reserved','cancelled') AND provider_ref IS NULL)
    OR (first_submission_at_ms BETWEEN 0 AND updated_at_ms AND attempt_number>0
      AND retry_window_ends_at_ms>first_submission_at_ms
      AND retry_window_ends_at_ms<=first_submission_at_ms+2592000000
      AND status<>'reserved'),FALSE))
);
ALTER TABLE rail_provider_payments ADD COLUMN IF NOT EXISTS authorization_required BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_provider_payments_owner ON rail_provider_payments(owner_wallet_id,operation_id);
CREATE INDEX IF NOT EXISTS idx_provider_payments_mandate_totals
  ON rail_provider_payments(mandate_id,status) WHERE authorization_required;
CREATE INDEX IF NOT EXISTS idx_provider_payments_shared_totals
  ON rail_provider_payments(shared_budget_id,status) WHERE authorization_required;
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_object_single_operation
  ON rail_provider_payments((binding->>'provider'),(binding->>'providerAccountRef'),provider_ref) WHERE provider_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS rail_provider_payment_history (
  operation_id UUID NOT NULL REFERENCES rail_provider_payments(operation_id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider_ref TEXT,
  recorded_at_ms BIGINT NOT NULL,
  PRIMARY KEY(operation_id,revision)
);
CREATE OR REPLACE FUNCTION rail_protect_provider_payment() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='rail_provider_payment_history' THEN
    RAISE EXCEPTION 'provider_payment_history_is_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.attempt_number<>0 OR NEW.last_event<>'created' OR NEW.status<>'reserved' THEN
      RAISE EXCEPTION 'provider_payment_initial_state_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.operation_id,NEW.owner_wallet_id,NEW.agent_id,NEW.mandate_id,NEW.shared_budget_id,NEW.intent_id,
      NEW.binding,NEW.fingerprint,NEW.idempotency_key,NEW.authorization_required)
    IS DISTINCT FROM ROW(OLD.operation_id,OLD.owner_wallet_id,OLD.agent_id,OLD.mandate_id,OLD.shared_budget_id,OLD.intent_id,
      OLD.binding,OLD.fingerprint,OLD.idempotency_key,OLD.authorization_required)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at_ms<OLD.updated_at_ms
    OR (OLD.first_submission_at_ms IS NOT NULL AND ROW(NEW.first_submission_at_ms,NEW.retry_window_ends_at_ms)
      IS DISTINCT FROM ROW(OLD.first_submission_at_ms,OLD.retry_window_ends_at_ms))
    OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
    OR (OLD.status IN ('succeeded','failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status)
    OR NEW.attempt_number<>OLD.attempt_number+(CASE WHEN NEW.last_event IN ('begin_submission','retry_submission') THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'provider_payment_binding_or_history_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rail_provider_payment_immutable ON rail_provider_payments;
CREATE TRIGGER rail_provider_payment_immutable BEFORE INSERT OR UPDATE OR DELETE ON rail_provider_payments
  FOR EACH ROW EXECUTE FUNCTION rail_protect_provider_payment();
DROP TRIGGER IF EXISTS rail_provider_history_immutable ON rail_provider_payment_history;
CREATE TRIGGER rail_provider_history_immutable BEFORE UPDATE OR DELETE ON rail_provider_payment_history
  FOR EACH ROW EXECUTE FUNCTION rail_protect_provider_payment();
CREATE OR REPLACE FUNCTION rail_journal_provider_payment() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
  INSERT INTO rail_provider_payment_history(operation_id,revision,status,event_type,attempt_number,provider_ref,recorded_at_ms)
    VALUES(NEW.operation_id,NEW.revision,NEW.status,NEW.last_event,NEW.attempt_number,NEW.provider_ref,NEW.updated_at_ms);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_provider_payment_journal ON rail_provider_payments;
CREATE TRIGGER rail_provider_payment_journal AFTER INSERT OR UPDATE ON rail_provider_payments
  FOR EACH ROW EXECUTE FUNCTION rail_journal_provider_payment();

CREATE TABLE IF NOT EXISTS rail_provider_payment_consents (
  operation_id UUID PRIMARY KEY REFERENCES rail_provider_payments(operation_id),
  merchant_wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  challenge_id UUID NOT NULL UNIQUE REFERENCES rail_owner_step_up_grants(challenge_id),
  canonical_payload TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL CHECK(operation_fingerprint=encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'))
);
CREATE OR REPLACE FUNCTION rail_protect_provider_consent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'provider_consent_is_immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS rail_provider_consent_immutable ON rail_provider_payment_consents;
CREATE TRIGGER rail_provider_consent_immutable BEFORE UPDATE OR DELETE ON rail_provider_payment_consents
  FOR EACH ROW EXECUTE FUNCTION rail_protect_provider_consent();
CREATE OR REPLACE FUNCTION rail_check_provider_consent() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE id UUID; payment rail_provider_payments; consent rail_provider_payment_consents;
BEGIN
  IF TG_TABLE_NAME='rail_agent_intents' THEN
    IF EXISTS(SELECT 1 FROM rail_provider_payments WHERE intent_id=NEW.intent_id AND authorization_required) THEN
      RAISE EXCEPTION 'provider_intent_namespace_conflict' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  id:=NEW.operation_id;
  SELECT * INTO payment FROM rail_provider_payments WHERE operation_id=id;
  SELECT * INTO consent FROM rail_provider_payment_consents WHERE operation_id=id;
  IF NOT payment.authorization_required THEN
    IF consent.operation_id IS NOT NULL THEN RAISE EXCEPTION 'provider_consent_requires_new_operation' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF consent.operation_id IS NULL OR consent.canonical_payload::jsonb IS DISTINCT FROM
      jsonb_build_array('rail:owner-operation:v1','provider_payment',payment.fingerprint,consent.merchant_wallet_id)
    OR EXISTS(SELECT 1 FROM rail_agent_intents WHERE intent_id=payment.intent_id)
    OR NOT EXISTS(SELECT 1 FROM rail_owner_step_up_grants grant_record JOIN users owner ON owner.user_id=grant_record.user_id
      WHERE grant_record.challenge_id=consent.challenge_id AND owner.wallet_id=payment.owner_wallet_id
        AND grant_record.operation='provider_payment' AND grant_record.operation_fingerprint=consent.operation_fingerprint
        AND grant_record.consumed_at>=grant_record.created_at AND grant_record.consumed_at<grant_record.expires_at)
    OR NOT EXISTS(SELECT 1 FROM rail_agent_mandates mandate WHERE mandate.mandate_id=payment.mandate_id
      AND mandate.currency=payment.binding->>'currency' AND (payment.binding->>'amountMinor')::bigint<=mandate.per_payment_limit_minor
      AND consent.merchant_wallet_id=ANY(mandate.allowed_receiver_wallet_ids)) THEN
    RAISE EXCEPTION 'provider_owner_consent_binding_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_provider_consent_check ON rail_provider_payments;
CREATE CONSTRAINT TRIGGER rail_provider_consent_check AFTER INSERT OR UPDATE ON rail_provider_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_provider_consent();
DROP TRIGGER IF EXISTS rail_provider_consent_record_check ON rail_provider_payment_consents;
CREATE CONSTRAINT TRIGGER rail_provider_consent_record_check AFTER INSERT ON rail_provider_payment_consents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_provider_consent();
DROP TRIGGER IF EXISTS rail_provider_internal_namespace ON rail_agent_intents;
CREATE CONSTRAINT TRIGGER rail_provider_internal_namespace AFTER INSERT ON rail_agent_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rail_check_provider_consent();

CREATE OR REPLACE FUNCTION rail_account_provider_budget() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE amount BIGINT; old_held BIGINT:=0; old_spent BIGINT:=0; new_held BIGINT:=0; new_spent BIGINT:=0;
BEGIN
  IF NOT NEW.authorization_required THEN RETURN NULL; END IF;
  amount:=(NEW.binding->>'amountMinor')::bigint;
  IF TG_OP='UPDATE' THEN
    IF OLD.status='succeeded' THEN old_spent:=amount;
    ELSIF OLD.status NOT IN ('failed','cancelled') THEN old_held:=amount; END IF;
  END IF;
  IF NEW.status='succeeded' THEN new_spent:=amount;
  ELSIF NEW.status NOT IN ('failed','cancelled') THEN new_held:=amount; END IF;
  IF new_held=old_held AND new_spent=old_spent THEN RETURN NULL; END IF;
  UPDATE rail_agent_mandates SET reserved_budget_minor=reserved_budget_minor+new_held-old_held,
    spent_budget_minor=spent_budget_minor+new_spent-old_spent
    WHERE mandate_id=NEW.mandate_id AND currency=NEW.binding->>'currency'
      AND reserved_budget_minor+new_held-old_held>=0 AND spent_budget_minor+new_spent-old_spent>=0
      AND reserved_budget_minor+new_held-old_held+spent_budget_minor+new_spent-old_spent<=total_budget_minor;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_mandate_budget_unavailable' USING ERRCODE='23514'; END IF;
  UPDATE rail_shared_budgets SET reserved_budget_minor=reserved_budget_minor+new_held-old_held,
    spent_budget_minor=spent_budget_minor+new_spent-old_spent
    WHERE budget_id=NEW.shared_budget_id AND currency=NEW.binding->>'currency'
      AND reserved_budget_minor+new_held-old_held>=0 AND spent_budget_minor+new_spent-old_spent>=0
      AND reserved_budget_minor+new_held-old_held+spent_budget_minor+new_spent-old_spent<=total_budget_minor;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider_shared_budget_unavailable' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rail_provider_budget_accounting ON rail_provider_payments;
CREATE TRIGGER rail_provider_budget_accounting AFTER INSERT OR UPDATE ON rail_provider_payments
  FOR EACH ROW EXECUTE FUNCTION rail_account_provider_budget();
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
      ADD COLUMN IF NOT EXISTS work_kind TEXT NOT NULL DEFAULT 'event'
        CHECK (work_kind IN ('event', 'provider_payment')),
      ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'processing', 'delivered', 'dead_letter')),
      ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS lease_id UUID,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;
    CREATE OR REPLACE FUNCTION rail_protect_outbox_work_kind() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.work_kind IS DISTINCT FROM OLD.work_kind THEN
        RAISE EXCEPTION 'outbox_work_kind_is_immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS rail_outbox_work_kind_immutable ON outbox;
    CREATE TRIGGER rail_outbox_work_kind_immutable BEFORE UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION rail_protect_outbox_work_kind();
    CREATE INDEX IF NOT EXISTS idx_outbox_event_delivery
      ON outbox (next_attempt_at, id)
      WHERE work_kind = 'event' AND delivery_status IN ('pending', 'processing');
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
