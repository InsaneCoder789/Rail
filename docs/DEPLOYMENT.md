# Rail Deployment

Rail can run locally as a long-lived Node.js process or as a Vercel serverless API. The Vercel entry point is `api/index.ts`; it reuses the same request routing and business logic as the local server.

## Architecture

### Local Acceptance Is Not Deployment Acceptance

The latest full local backend run passed 361 tests without failures/skips. `npm run test:browser` additionally requires PostgreSQL and Playwright Chromium and exercises native WebAuthn, signed money routes, owner-approved agent key rotation and recovery in a temporary schema. Install that browser with `npx playwright install chromium` locally; CI uses `--with-deps` on Ubuntu. The fixture generates temporary test keys and cleans its schema, without provisioning production credentials. Goals 1 and 2 backend implementation/local acceptance are complete. Hosted/proxy/physical-device acceptance, custody/restore and independent certification remain Goal 12; a virtual authenticator cannot prove those requirements. Audit retained keys before rollout: new validation rejects degenerate Ed25519 points and unsafe owner RSA parameters, including legacy assertions/grants. Do not weaken validation or manufacture replacement consent to bypass cutover.

Vercel hosts the HTTP function. A managed PostgreSQL provider stores wallets, users, authorizations, idempotency records, offline tokens, ledger entries, and outbox events. Vercel environment variables provide secrets at runtime.

The API is reachable over HTTPS, but it is not an unauthenticated public product. Payment routes require a JWT or scoped API key, and token-issue and sync routes require the server API key. Do not publish the deployment URL in the frontend until the frontend has been configured with the correct origin and credentials.

## Required Vercel variables

Agent HTTP use additionally requires `RAIL_AGENT_API_ORIGIN=https://your-public-api.example`, canonical with no trailing slash/path. It is independent of the owner's WebAuthn frontend origin. Missing configuration disables proof endpoints; malformed values fail startup. The real runtime always requires public-key agent credentials, so replace old bearer credentials through owner step-up rather than enabling a downgrade flag. See [Agent Proof Of Possession](AGENT_PROOF_OF_POSSESSION.md) for nonce/bootstrap/header/retry contracts. Database dispatch state and grants must migrate before new writers run, and old bearer writers must be drained. Physical/hosted-origin and proxy acceptance remain unverified locally.

Configure these for the **Production** environment:

```text
DATABASE_URL=postgresql://...
RAIL_API_KEY=<long-random-server-key>
RAIL_API_KEY_SCOPES=offline_tokens:issue,sync:write
RAIL_SIGNING_SECRET=<long-random-signing-secret>
JWT_SECRET=<long-random-jwt-secret>
RAIL_EVIDENCE_KEY_RING=<private JSON key ring described below>
RAIL_RISK_RECORD_KEY_RING=<independent private JSON key ring described below>
RAIL_AGENT_AUTHORITY_KEY_RING=<third independent private JSON ring, needed for agent spending>
RAIL_ALLOWED_ORIGINS=https://your-frontend.example
RAIL_REQUIRE_JSON_CONTENT_TYPE=true
RAIL_EXPOSE_INTERNAL_ERRORS=false
RAIL_TRUST_PROXY_HEADERS=true
```

Use separate values for Preview and Development. Never upload `.env` or copy real secrets into `.env_example`.

## Protected payment evidence keys

HTTP startup now requires `RAIL_EVIDENCE_KEY_RING` in local and hosted modes. It fails before connecting if keys are absent or malformed. There is no silent plaintext fallback. This is a deployment configuration change; provision secrets before switching API instances.

The JSON value has the following shape. Placeholders are not usable keys:

```json
{
  "activeKeyId": "evidence_2026_10",
  "maxRecordsPerKey": 1000000,
  "keys": [
    {
      "keyId": "evidence_2026_10",
      "encryptionKey": "<base64 of 32 random bytes>",
      "authenticationKey": "<base64 of 32 different random bytes>"
    }
  ]
}
```

Generate each value independently with a trusted cryptographic secret generator, such as `openssl rand -base64 32`, and store the JSON in deployment secret storage. Do not commit, print in CI, share with clients, or reuse JWT/authorization/webhook secrets as evidence keys. The runtime accepts up to 32 versions and rejects duplicate IDs or reused material across purposes/versions. This is an application-loaded symmetric key ring, not KMS or HSM support.

Rotate by first deploying the old and new independent versions together to all instances, then switching the active ID consistently. Retain old versions for the evidence retention period, and test restore in an isolated environment. Do not replace material under an existing ID. Removing a required old version makes its status `verification_unavailable`, not `verified`. A lost key cannot be recovered from ciphertext; backup policy and restore testing remain operator responsibilities.

The database enforces a configurable maximum of at most one million committed records per encryption-key fingerprint and unique committed nonces. Counters share the financial transaction and roll back with failed attempts; this is a committed-record ceiling, NOT a total count of all encryption invocations. Quota exhaustion aborts new payments until a fresh active key is configured. Existing completed replays do not consume quota. Monitor usage, rotate early and impose operational limits on failed encryption attempts too. Random 96-bit nonces do not justify unlimited encryption with one key.

Apply migrations before the new runtime. New required-evidence payments cannot commit without their bound evidence, and evidence rows reject updates/deletes. Legacy executions stay explicitly unprotected; do not invent a backfill or delete replay records. Stop/drain older API writers during cutover because an older writer can still create an execution without the new required-evidence marker. A rolling mixed-version deployment is not evidence-complete.

The library engine keeps evidence optional for isolated V1 regression/demo callers; the HTTP runtime always supplies the evidence store. Direct library integrations must opt in explicitly. Ledger fields and existing event payloads remain relational/plaintext; this phase encrypts the canonical audit copy only. Least-privilege database roles, retention, secure secret storage, monitoring and a production key-provider review remain release gates.

## Database setup

### Owner Passkey Ceremony Configuration

Optional `RAIL_WEBAUTHN_RP_ID` and `RAIL_WEBAUTHN_ORIGIN` enable the new ceremony endpoints. Both must be supplied together; the RP ID equals the origin hostname and production requires a canonical HTTPS origin. Malformed/partial settings fail before the pool opens. No actual deployment values were changed. Apply migrations first and keep runtime roles unable to delete credential history or modify guards. [OWNER_PASSKEYS.md](./OWNER_PASSKEYS.md) explains session binding and lifecycle limits.

The HTTP runtime requires grants for execution credentials, mandates, approvals, factor removal and code rotation. Lost-key recovery requires the current password and an unused recovery code, then replaces password/session authority, withdraws agent delegations and scopes re-enrollment to a new session. Missing passkey configuration disables these features rather than providing a JWT/password-only fallback. Keep emergency revocation available. Browser/hosted acceptance, custody/restore and actual notification delivery remain pending.

This migration enforces a unique authentication owner per wallet. Audit duplicate `users.wallet_id` mappings before deployment; it fails rather than choosing one owner or deleting accounts. Retain password/session epochs, factor/code history and referenced recovery records. First/recovery enrollment returns ten codes once; a recovered owner must provision new agent authority explicitly, not reactivate revoked agents. Remaining codes permit retry after a lost recovery response only while enrollment is pending. Successful re-enrollment rotates them, and the scoped capability never authorizes spending. No support override or out-of-band delivery service is configured.

Drain old writers before this cutover. Old nullable credential/mandate/intent markers are not upgraded in place; release old unexecuted holds and obtain new stepped authority. Historical protected receipts remain verifiable and completed outcomes can replay through a fresh execution credential without rewriting their original assurance. Every direct production integration must configure required owner control like the HTTP runtime. Creation and consumption use owner-user locks before agent/control locks; preserve that order in recovery and future workers. `consumed_at` and grant/credential/evidence links are durable history, not disposable session cache.

### Merchant Quote Trust Configuration

`RAIL_MERCHANT_QUOTE_KEYS` is optional; absence enables no trusted signed quotes and preserves unsigned transfers. A configured malformed registry fails before the pool opens. The value is a bounded JSON array (1-100 entries):

```json
[
  {
    "keyId": "merchant_2026_10",
    "merchantWalletId": "merchant_wallet",
    "status": "active",
    "publicKey": "<canonical base64 DER SPKI Ed25519 public key>"
  }
]
```

Only public keys belong here. Authenticate merchant/recipient ownership outside the agent channel before enrollment; configuration does not provide KYC. Never put private signing keys in Rail, frontend bundles, agent credentials or this registry. Duplicate IDs/material, private/wrong-algorithm keys and unknown fields/statuses are rejected. There is no new secret generated automatically and no merchant configured in the repository.

Rotate with a new ID and key, retaining old entries as `revoked` when no longer accepted. Every recipient still present requires signed quotes, even if all its keys are revoked. Deleting all its entries removes that requirement; it is an explicit policy removal, not safe revocation. Deploy the same registry to every HTTP/library writer, draining mismatched versions; this application cannot enforce consistent trust across differently configured instances. Previously approved unsigned intents for newly enrolled recipients cannot execute; reject/release them and obtain signed replacements. Completed payments retain protected public-key snapshots and can replay their historical outcome after revocation. No network quote fetching, merchant private-key hosting, provider integration or live deployment is included.

### Protected risk-record cutover

HTTP startup also requires `RAIL_RISK_RECORD_KEY_RING`, using the same JSON shape as the evidence ring but independently generated AES and HMAC material. Startup rejects material shared with any currently configured or retained payment-evidence key. Maintain an operator key inventory for older, removed versions too; application configuration cannot check unknown historical material. No existing secret is automatically replaced or generated. Provision both rings in secret storage before starting the updated runtime.

Apply migrations and stop/drain older writers before cutover. New HTTP payments require a bound protected risk row at financial commit. Detailed features, model hashes and predictions are stored only in that encrypted record; observation time, explanation codes and model availability/version/synthetic flag remain queryable. Participant reads verify that summary against the record. Missing retained keys or verification errors suppress the summary rather than falling back to clear data. Existing plaintext observations are marked `legacy_plaintext`, not backfilled or deleted. Optional library callers must supply the risk store and enable the engine requirement explicitly.

Risk key versions have their own committed-record quotas and nonce uniqueness checks. Rotation and retention follow the evidence procedure: distribute both old and fresh independent versions before switching active IDs, retain decryption keys and verify isolated restore. Quota exhaustion aborts new payments; replay consumes no new quota. Rollbacks undo the counter, so failed-attempt monitoring remains operational work. Do not delete risk records or key-usage counters to bypass limits. No automatic retention, historical encryption migration, KMS integration or verified production recovery is delivered by this cutover. Pending agent-intent fields, financial relational data and remaining lifecycle events are not encrypted by these envelopes.

The current payment path requires the `rail_payment_executions` table and transactional outbox schema. Apply migrations before updating API instances. PostgreSQL deduplication uses transaction-scoped advisory locks, not session locks. Verify the selected provider's transaction pooling and deadline behavior in its sandbox before live use.

New HMAC requests use versioned JSON-array canonical payloads and include `authorizationId`. Regenerate signatures using the exported helper. Stored completed legacy replay fingerprints are upgraded only when authorization and ledger evidence match; unverifiable historical records need reconciliation. Do not delete idempotency records to force a retry.

Apply the schema from a trusted environment before enabling the Vercel deployment:

```bash
DATABASE_URL='postgresql://...' npm run migrate
```

Hosted requests do not run DDL migrations or the authorization expiry sweep. This prevents multiple serverless instances from competing over startup work. Run migrations as a release step, and schedule expiry cleanup separately when deploying beyond a project demo.

## Deploy

After linking the repository to a Vercel project, deploy with the Vercel dashboard or CLI. The build command is `npm run build`, and the rewrite sends API paths such as `/health` and `/v1/payments/execute` to the function at `/api`.

Before a production deployment, run:

```bash
npm run build
```

Then verify the deployment with an authenticated smoke test. A public `GET /health` response only confirms that the function is reachable; it does not prove that PostgreSQL, migrations, authentication, or payment execution are configured correctly.

## Operational limitations

### Agent Controls and Atomic Execution

The V2.1 schema adds `rail_agents`, `rail_agent_credentials`, `rail_agent_mandates` and `rail_agent_intents`, with immutable intent bindings, consumed/held budget-sum checks and deferred links to protected payment executions. Apply migrations before updating hosted instances. The new execution scope is opt-in: migration does not upgrade existing `payments:propose` credentials. Owner management and intent decisions accept only user JWTs with current credential versions; existing service/wallet API keys cannot manage agents. Agent tokens are distinct, hashed at rest, expiring and revoked through owner endpoints. Never record the one-time issuance response in proxy/APM logs; store it in restricted server-side credential storage.

Approved intents can execute online through `POST /v2/agent/intents/:intentId/execute` with an explicit `payments:execute` credential and only the exact `requestFingerprint`. The runtime requires durable supplied-client execution, mandatory evidence and a securely generated `RAIL_SIGNING_SECRET` whose trimmed length is at least 32 characters; otherwise execution and execution-credential issuance return 503. This requirement also applies in development. Do not rotate established secrets casually: preserve existing authorization compatibility and perform a reviewed cutover. No HMAC or evidence key may be distributed to agents.

Proposals and human approvals reserve mandate headroom, not wallet funds. Execution checks available funds and live authority; money, authorization, ledger, evidence, durable replay, consumed budget and intent/audit state commit together. The API returns a receipt only after final commit. Deferred failure rolls everything back. Execution does not grant access to existing owner execute/sync routes. Both fresh execution and replay require active credential, agent and mandate authority; owner history remains accessible after revocation. These are internal wallet transfers, not verified bank/UPI settlement.

Intent lifetimes are 60-900 seconds, clipped to the mandate deadline. Expiry cleanup happens during successful intent/mandate reads and intent mutations, not a background interval; failed transactions also roll cleanup back. Revoking an agent or mandate releases unexecuted holds, never consumed budget. Single-credential revocation invalidates subsequent token use but leaves other agent intents intact. Agent execution locks wallets in sorted order and skips unrelated authorization-expiry sweeps inside that lock scope. Schedule the existing authorization sweep separately so elapsed wallet reservations do not unnecessarily restrict available funds.

New agent mandates, effective owner decisions and spending require `RAIL_AGENT_AUTHORITY_KEY_RING`, with the same ring JSON shape and independent AES/HMAC material from every configured/retained payment and risk key. If absent, human HTTP startup continues but new protected grants/decisions and spending remain unavailable (503). Revocation remains available without decryption keys. Malformed or reused configured keys fail startup before pool creation. No actual secret is generated or overwritten. The ring's committed-record quota and nonce registry cover consent, decisions and execution together; preserve old keys and verify restore. Do not erase records/counters to bypass rotation.

New intents have immutable `authority_receipt_version = 1`; execution writes a server-authenticated policy/credential/exact-intent snapshot in `rail_agent_authority_evidence` before the outer financial commit. Missing required evidence aborts that commit. Original ciphertext is preserved on replay, which must verify the receipt before returning the committed result. The owner-only, non-cacheable `GET /v2/agents/:agentId/intents/:intentId/authority` distinguishes `not_executed`, `verified`, `legacy_unavailable` and `verification_unavailable` with safe reasons; it never exposes tokens or keys. Assurance is `server_observed_authority`, not a user signature or independently proven human presence.

New mandate consent and effective approve/reject decisions also retain immutable encrypted owner-context records. HTTP principal identity/version is server-derived and rechecked before recording; library calls are lower-assurance `trusted_library`. Execution verifies original consent/required approval and links their commitments. No raw JWT or user signature is stored. Repeated approval does not refresh the original record; historical provenance remains verifiable after session logout. Explicit agent/mandate revocation is needed to withdraw delegated permissions.

Apply migrations before writer cutover. Existing consent/intent owner markers stay NULL, never fabricated evidence. Already committed snapshots remain readable with explicit missing owner provenance. Old unexecuted requests need replacement; old mandates cannot create new proposals without fresh owner consent (`409 new_agent_owner_consent_required`). Release/revoke old unspent holds, create a fresh mandate/request ID and obtain applicable approval; do not overwrite old fingerprints or retroactively prove unknown consent. Do not mix old/new writers: old code cannot satisfy new mandatory records. Current v1 Merkle roots exclude these authority records; chain publication remains unfinished.

Monitor owner-global and agent-global 20/minute quotas, source quotas and retained-record capacities (50 agents/owner, 100 credentials and mandates/agent, 1,000 intents/agent). Lifecycle/retention decisions must not delete audit history automatically. Pending intent fields remain plaintext relational data. Database triggers protect normal writes, not an administrator disabling them; least-privilege runtime roles remain a production gate. Run the full PostgreSQL-backed suite and explicit agent/receipt tests before rollout.

### Internal transaction composition

Authorization issuance, PostgreSQL replay protection and the engine support supplied-client composition. These helpers are not permission APIs. The agent store is now a trusted coordinator: it begins one transaction, configures SQL deadlines, checks live authority, calls the helpers, performs budget/state writes and awaits outer `COMMIT` before returning success. Deferred constraints can fail that final commit. On any failure, roll back the whole operation and discard unusable clients; an inner savepoint only undoes its own scope. Never run overlapping operations on the same checked-out client. Preserve consistent lock ordering and check authority before cached replay. Existing owner HTTP execute/sync paths retain their normal self-contained engine boundary.

### Trusted Risk Observations

Apply the observation schema migration before rolling out the updated pipeline. New standard-pipeline executions require an immutable feature/assessment record at commit; old execution rows remain explicitly legacy/unobserved. Wallet-history queries use the same SQL deadlines and client as the payment, with a 30-day window and 1,000-sample cap. Monitor query latency, observation failures and sample truncation; a required-observation write failure rolls back the payment attempt rather than returning an unaudited result.

Optional `RAIL_RISK_MODEL_PATH` loads the legacy amount/channel model; `RAIL_BEHAVIOUR_MODEL_PATH` loads the expanded `behaviour-v1` artifact and takes precedence. Runtime files are limited to 1 MiB and validated/copied before opening the pool. Invalid configured artifacts fail startup. Expanded currency mismatch or a training cutoff not earlier than observation stores `currency_mismatch`/`not_yet_valid`, without silent legacy fallback or a fabricated score. Matching predictions/hashes are retained privately with the observation. Both models remain shadow-only; no model or `review` does not independently reject a payment.

Migrate the expanded model-status and protected-risk schema before updating hosted writers. Train expanded artifacts with the existing `risk:train` command using strict chronological training/validation/test arrays and label-availability timestamps. Keep datasets and model artifacts outside the repository; inspect held-out and calibration reports before a reviewed configuration rollout. Restart/cut over to a retained approved artifact for rollback; already committed snapshots remain unchanged. Do not enable fraud enforcement based on synthetic reports or experimental threshold 0.5. New HTTP feature snapshots use separate risk encryption as described above; historical plaintext, retention, least-privilege access, label provenance and independent evaluation still require review.

### Anomaly Baseline Rollout

Apply the additive `anomaly_summary` migration before updated writers/readers. Existing protected records lacking the new optional anomaly field remain verifiable as `not_configured`; the migration does not rewrite ciphertext. Configure optional `RAIL_ANOMALY_MODEL_PATH` only with an independently reviewed `behaviour-anomaly-v1` artifact. Runtime reads cap at 1 MiB; invalid artifacts fail before pool creation, and construction copies model parameters. Use the existing private `risk:train` workflow with bounded chronological training/calibration/test reference cohorts; generated artifacts are mode 0600 and cannot overwrite prior files.

This baseline runs alongside logistic inference, not instead of it. Detailed distances, contributions, artifact hash and threshold are retained only in encrypted risk records. The queryable/API anomaly summary exposes availability/version/synthetic status and is authenticated with the existing record. Cold start/truncation, wrong currency and future cutoff produce explicit unavailable statuses with no score. Replay retains its original assessment even after model replacement. No anomaly flag blocks a payment or approves an agent intent. No default model, automatic retraining, anomaly drift scheduler or fraud-accuracy claim is configured. Review reference contamination, population/currency mix, experimental scales/thresholds, independent outcome labels and real hosted inference/query latency before any enforcement.

### Offline Drift Checks

Run `npm run risk:monitor -- /private/path/cohorts.json` in an authorized offline/operator job, not inside a payment request. The bounded input supplies one expanded model and distinct chronological reference/current cohorts; the command does not export database data or verify its authenticity. Protect input and aggregate output from customer/public access. Codes 2 and 3 mean detected shift and insufficient data, not transfer failure. Inspect invalid-input code 1 rather than suppressing it; code 0 is not fraud/performance acceptance. No alert receiver, schedule or automatic model update is configured by this implementation. Reference selection and the experimental PSI threshold require use-case validation before relying on operational alerts.

### Durable Audit Batching

Apply migrations before updated writers/readers. New protected evidence enqueues `rail_audit_pending` in the financial commit; enqueue failure aborts that attempt. Migration also queues existing protected ciphertext without rewriting it. Unprotected legacy executions are excluded. Older API instances must be drained during cutover: they do not enforce the new queue requirement consistently. Keep runtime and maintenance database roles least-privilege; database owners can bypass triggers.

Run `npm run audit:batch` as an authorized finite maintenance command using the existing independent evidence/risk rings and retained historical versions. `RAIL_AUDIT_BATCH_SIZE` is 1-256, default 128; the command uses a one-connection pool. An indexed pending queue and transaction-scoped batch lock coordinate workers. Lock and statement deadlines are five/fifteen seconds; they are not a promised end-to-end latency. Schedule and monitor it explicitly; neither request startup nor this change installs a scheduler.

The worker authenticates selected payment envelopes and required risk envelopes before building leaves. One commit inserts root/count, immutable membership/proofs and consumes pending records. Partial writes, deferred failures and backend termination leave pending work for retry. Missing retained keys or corrupt evidence stop the batch without deleting/skipping records; restore reviewed keys or investigate under a controlled runbook, rather than changing financial history or disabling validation. The command reports generic `audit_batch_failed` on errors to avoid SQL identifier disclosure. Exit 0 with `empty` means no eligible pending work was found, not universal historical coverage. A lost command response may have committed a batch; inspect authenticated payment status before assuming failure. Re-running includes only remaining unbatched records.

The proof API has independent wallet-wide/source quotas and returns only participant-authorized data. Protect sibling hashes and ciphertext commitments from unrelated users. All batches remain unanchored with local-only verification; no EVM provider, fee spending, contract, signer, finality/reorg worker or independent checkpoint is configured. Root/proof inclusion is not external settlement or complete audit coverage. Production backlog/latency, retention, least-privilege deployment and key-restore acceptance remain open.

### Durable External Event Delivery

Configure `RAIL_OUTBOX_WEBHOOK_URL` as a trusted HTTPS receiver and `RAIL_OUTBOX_WEBHOOK_SECRET` as a separate random secret of at least 32 characters. The worker refuses redirects and URL credentials. Run `npm run outbox:dispatch` from a scheduled worker/cron environment after applying migrations; each invocation claims a bounded batch and exits. The command is not run during API requests or serverless cold starts.

The receiver must durably process and deduplicate the `Idempotency-Key`/`deliveryId` before returning a 2xx acknowledgement. Delivery is at least once: a worker can crash after the receiver processes an event but before recording its acknowledgement. Failure count, next attempt, lease and final dead-letter state are persisted in `outbox`. Monitor dead-letter rows and review before an explicit operator retry; never discard them to conceal delivery failure. Payment correctness does not depend on webhook availability.

PostgreSQL deployments use shared fixed-window rate-limit buckets with row locking. Memory-only development uses a process-local sliding window. Capacity testing and retention for old buckets remain operational work.

The current SSE event stream is designed for a long-lived Node process. It is explicitly disabled on Vercel serverless execution, so hosted clients should use `GET /v1/events` polling until event delivery is moved to a managed pub/sub service.

The authorization expiry sweep uses an interval in a warm process. Hosted production should add a scheduled job that calls a protected maintenance endpoint, or move expiry cleanup into transactional reads and a managed job system.

## Security checklist

- Use a managed PostgreSQL instance with TLS enabled.
- Keep the Vercel project private and restrict project collaborators.
- Use a random API key and separate secrets for each environment.
- Configure only the scopes required by the deployment; token issuance and synchronization are checked independently.
- Set `RAIL_ALLOWED_ORIGINS` to exact frontend origins; do not use `*`.
- Trust forwarded client-IP headers only when the hosting proxy is known to sanitize them.
- Keep `RAIL_EXPOSE_INTERNAL_ERRORS=false` in production.
- Do not use API keys in query strings for ordinary API calls.
- Rotate secrets if they are ever printed, committed, or shared.
- Treat this as a project/demo deployment until external provider, compliance, monitoring, backup, and incident-response requirements are completed.
