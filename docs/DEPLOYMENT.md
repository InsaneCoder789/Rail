# Rail Deployment

Rail can run locally as a long-lived Node.js process or as a Vercel serverless API. The Vercel entry point is `api/index.ts`; it reuses the same request routing and business logic as the local server.

## Architecture

Vercel hosts the HTTP function. A managed PostgreSQL provider stores wallets, users, authorizations, idempotency records, offline tokens, ledger entries, and outbox events. Vercel environment variables provide secrets at runtime.

The API is reachable over HTTPS, but it is not an unauthenticated public product. Payment routes require a JWT or scoped API key, and token-issue and sync routes require the server API key. Do not publish the deployment URL in the frontend until the frontend has been configured with the correct origin and credentials.

## Required Vercel variables

Configure these for the **Production** environment:

```text
DATABASE_URL=postgresql://...
RAIL_API_KEY=<long-random-server-key>
RAIL_API_KEY_SCOPES=offline_tokens:issue,sync:write
RAIL_SIGNING_SECRET=<long-random-signing-secret>
JWT_SECRET=<long-random-jwt-secret>
RAIL_EVIDENCE_KEY_RING=<private JSON key ring described below>
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

No extra deployment secret is introduced. Monitor owner-global and agent-global 20/minute quotas, source quotas and retained-record capacities (50 agents/owner, 100 credentials and mandates/agent, 1,000 intents/agent). Lifecycle/retention decisions must not delete audit history automatically. Pending intent fields are not AES-encrypted evidence. Database triggers protect normal data writes, not a database owner capable of disabling them; least-privilege runtime roles remain a production gate. Run the complete PostgreSQL-backed suite and the explicit agent test step before rollout.

### Internal transaction composition

Authorization issuance, PostgreSQL replay protection and the engine support supplied-client composition. These helpers are not permission APIs. The agent store is now a trusted coordinator: it begins one transaction, configures SQL deadlines, checks live authority, calls the helpers, performs budget/state writes and awaits outer `COMMIT` before returning success. Deferred constraints can fail that final commit. On any failure, roll back the whole operation and discard unusable clients; an inner savepoint only undoes its own scope. Never run overlapping operations on the same checked-out client. Preserve consistent lock ordering and check authority before cached replay. Existing owner HTTP execute/sync paths retain their normal self-contained engine boundary.

### Trusted Risk Observations

Apply the observation schema migration before rolling out the updated pipeline. New standard-pipeline executions require an immutable feature/assessment record at commit; old execution rows remain explicitly legacy/unobserved. Wallet-history queries use the same SQL deadlines and client as the payment, with a 30-day window and 1,000-sample cap. Monitor query latency, observation failures and sample truncation; a required-observation write failure rolls back the payment attempt rather than returning an unaudited result.

Optional `RAIL_RISK_MODEL_PATH` still loads the amount/channel model in shadow mode. Model validation/copying fixes the runtime artifact; matching predictions and its hash are retained with the observation, not exposed through the participant summary API. No model does not mean unavailable funds or rejected payment, and `review` is only explanatory. Do not enable fraud enforcement based on these demonstration thresholds. Feature snapshots are sensitive relational records, not encrypted transaction evidence; production retention, least-privilege access, label provenance and model evaluation remain required.

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
