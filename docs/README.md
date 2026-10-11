# Rail

Rail is an offline-capable payment orchestration service built to explore how a fintech backend can safely handle authorization, offline headroom, replay-safe execution, and reconnect-time synchronization.

In practical terms, Rail is a payment control and execution backend. It is designed to sit between an application experience and the underlying money-movement rails, where it can enforce authorization rules, protect retries, coordinate offline-capable flows, and keep payment state observable.

The project is intentionally positioned as a control and execution layer, not as a bank settlement rail. It does not replace UPI, card networks, or PSP settlement systems. Instead, it focuses on the part of the problem where a backend must:

- issue bounded authorization to spend
- reserve funds before final execution
- support offline-capable payment initiation
- process retries safely
- replay queued offline transactions consistently
- record ledger activity and emit operational events

The HTTP application requires PostgreSQL for authentication, wallet accounting, replay protection and events. Memory components remain available for isolated tests and examples, not as an alternate payment-server runtime.

The current `main` branch focuses on transaction safety, explainable architecture and security-conscious backend design. The [V1 acceptance record](V1_SIGN_OFF.md) distinguishes verified demonstration behavior from outstanding data and production-release gates.

**Repository:** [github.com/InsaneCoder789/Rail](https://github.com/InsaneCoder789/Rail)



<img width="1752" height="897" alt="image" src="https://github.com/user-attachments/assets/343a760c-a171-4fa7-b06c-35b03984ee89" />



---

## What Rail Does

At a high level, Rail supports the following flow:

1. A user authenticates and is mapped to a wallet.
2. The sender requests a payment authorization.
3. Rail reserves the sender’s funds and persists an authorization record.
4. For offline use cases, Rail can issue a device-bound offline token with limited spend headroom.
5. A payment is executed through validation and prechecks; authorization, wallets, offline headroom, ledger, events and replay results commit in one PostgreSQL transaction.
6. If the device was offline, queued transactions can later be replayed through the sync endpoint using the same stored authorization model.
7. The backend emits wallet-visible events for dashboards and operational visibility.

That makes Rail more than a simple transfer API. It behaves like a controlled payment runtime with explicit lifecycle state, replay protection, offline-aware constraints, and ledger-visible execution.

### What Offline Means Here

Rail supports preissued authority, device-bound spend headroom and reconnect-time processing of queued requests. Server-side verification and final ledger posting require connectivity to Rail. The `nfc`, `ble` and `qr` channel values model payment inputs; this repository does not implement the mobile transport, secure device storage or a protocol proving final settlement while both devices are disconnected. A queued offline attempt must not be displayed as confirmed settlement.

No-internet UPI through USSD or voice is a different mechanism: it still reaches a payment service over a telecom network. Rail has no bank, NPCI, USSD or IVR connector today. Its useful upgrade path is enforceable delegated authority and recovery, not claiming to replace those networks.

---

## Why This Project Exists

Most payment demos stop at a simple request-response transfer. Rail goes further and models the harder problems that show up in real financial systems:

- offline-capable payment initiation
- bounded spend headroom
- authorization lifecycle tracking
- retry safety and anti-replay controls
- transaction-aware ledger posting
- event-driven visibility into execution state

The goal of the project is not to claim production readiness. The goal is to build a system that demonstrates real fintech backend thinking in a way that is technically serious, explainable, and extensible.

---

## Current Architecture

```mermaid
flowchart LR
  Client["Client / Frontend / Device"]
  Auth["Auth Routes\nregister / login / logout-all"]
  Authorize["Authorize Route\nreserve funds + persist authorization"]
  Token["Offline Token Route\nissue device-bound headroom"]
  Execute["Execute Route\nvalidate + idempotent pipeline run"]
  Sync["Sync Route\nreplay queued offline transactions"]
  Events["Event Routes\nrecent events + SSE stream"]

  Engine["PaymentPipelineEngine"]
  Validation["Validation Stage"]
  Prechecks["Parallel Prechecks\nsignature + risk"]
  Commit["Single PostgreSQL Transaction"]

  Wallets[("wallets")]
  Authorizations[("authorizations")]
  Tokens[("rail_offline_tokens")]
  Idempotency[("rail_idempotency")]
  Ledger[("ledger_entries")]
  Outbox[("outbox")]

  Client --> Auth
  Client --> Authorize
  Client --> Token
  Client --> Execute
  Client --> Sync
  Client --> Events

  Authorize --> Authorizations
  Authorize --> Wallets
  Token --> Tokens

  Execute --> Engine
  Sync --> Engine

  Engine --> Idempotency
  Engine --> Validation
  Engine --> Prechecks
  Engine --> Commit

  Commit --> Wallets
  Commit --> Authorizations
  Commit --> Tokens
  Commit --> Ledger
  Commit --> Outbox
  Commit --> Idempotency
```

---

## Payment Flow

The most important design decision in the current system is that payment execution is authorization-first.

### Authorization flow

When a sender requests authorization:

- identity is checked using JWT or API key
- sender and receiver details are validated
- sender funds are reserved
- an authorization record is persisted
- a signed authorization object is returned

The key improvement here is that authorization is no longer just a client-carried signed blob. The server keeps a durable source of truth in PostgreSQL and tracks authorization status over time.

### Execute flow

When a payment is executed:

- the request is authenticated
- the transaction is validated
- the stored `authorizationId` is loaded and matched against the transaction
- the idempotency layer protects retries
- the pipeline runs validation and prechecks using a single durable payment transaction
- the authorization is claimed inside the payment transaction
- the sender reservation is consumed
- the receiver balance is credited
- ledger rows are written
- ledger entries, execution fingerprints, replay results and outbox events commit with the wallet changes

### Sync flow

When offline transactions reconnect:

- sync accepts offline transactions only
- each transaction must include `authorizationId`
- each transaction must use the same outer `deviceId`
- transactions are validated against stored authorization state before execution
- the same engine path is reused instead of inventing a separate replay system

That keeps offline replay consistent with direct execution instead of making it a weaker side path.

---

## Runtime Flow

```mermaid
flowchart TD
  A["POST /v1/payments/authorize"] --> B["Reserve sender funds"]
  B --> C["Persist authorization record"]
  C --> D["Return signed authorization"]

  D --> E["POST /v1/payments/execute"]
  E --> F["Load stored authorization"]
  F --> G["Idempotency check"]
  G --> H["Pipeline validation"]
  H --> I["Parallel prechecks"]
  I --> J["Claim authorization in DB transaction"]
  J --> K["Consume reserved funds"]
  K --> L["Credit receiver"]
  L --> M["Write ledger entries"]
  M --> N["Insert durable outbox events"]
  N --> O["Store execution + replay result"]
  O --> P["Commit once; rollback all effects on failure"]
```

---

## Main Features

| Area | Current behavior |
|---|---|
| Authentication | User registration, password hashing, JWT login, wallet resolution |
| Authorization | Durable authorization lifecycle with reserve-before-execute behavior |
| Offline tokens | Device-bound spend headroom with expiry and remaining balance tracking |
| Execution pipeline | Validation, bounded prechecks and one atomic financial/replay commit |
| Sync replay | Offline-only batch replay with stored `authorizationId` enforcement |
| Idempotency | PostgreSQL-backed in the HTTP application; bounded memory store for isolated tests |
| Event visibility | Authenticated wallet-scoped events via REST and SSE |
| Rate limiting | Route-specific limits for login, authorize, execute, sync, and token issue |

---

## Project Status

Development continues directly on `main`. Agent execution and trusted behavioural observations now build on the protected payment foundation. The optional logistic model remains shadow-only; no model can override financial authority. Offline initiation and reconnect synchronization remain part of the system. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for open findings and [V2_TECHNICAL_GUIDE.md](./V2_TECHNICAL_GUIDE.md) for implementation details.

Salted Merkle commitments and inclusion proofs provide a tested foundation for future audit anchoring. Blockchain publication and durable audit storage are not yet implemented.

The project has already gone through several important improvements:

- Phase 1 introduced persisted authorization lifecycle management and transactional reserve-plus-issue behavior.
- Phase 2 aligned sync replay with the same stored-authorization model used by direct execution.
- Security hardening added stricter JWT behavior, protected event access, fail-closed API-key routes, cleaner auth responses, and route-specific rate limiting.
- The HTTP layer was refactored so `src/server/server.ts` remains the bootstrap entrypoint while route families and shared concerns live in focused modules.

For the full technical history, architecture notes, and file-by-file source map, see [PROJECT_STATUS_REPORT.md](./PROJECT_STATUS_REPORT.md).

---

## Tech Stack

- Node.js
- TypeScript
- PostgreSQL
- `pg`
- `bcryptjs`
- `jsonwebtoken`
- Server-Sent Events for live event streaming

---

## Requirements

- Node.js 20 or newer
- npm
- PostgreSQL 14 or newer for durable mode
- Docker is optional if you want a local Postgres container

---

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/InsaneCoder789/Rail.git
cd Rail
npm install
```

### 2. Configure environment

Create a `.env` file from the project example and fill in the values you want to use.

At minimum, a serious local run should define:

```bash
PORT=8787
DATABASE_URL=postgres://rail:rail_dev_password@127.0.0.1:5432/rail
JWT_SECRET=replace_this_with_a_real_secret
RAIL_SIGNING_SECRET=replace_this_with_a_real_secret
RAIL_API_KEY=replace_this_with_a_real_secret
RAIL_EVIDENCE_KEY_RING=<private JSON key ring; see DEPLOYMENT.md>
```

### 3. Start PostgreSQL

If you are using Docker:

```bash
docker compose up -d
```

### 4. Start the server

```bash
npm run server
```

### 5. Check health

```bash
curl -s http://127.0.0.1:8787/health
```

Example response:

```json
{
  "ok": true,
  "service": "rail",
  "persistence": "postgresql",
  "offline": {
    "tokenIssue": "POST /v1/offline/tokens/issue",
    "execute": "POST /v1/payments/execute",
    "sync": "POST /v1/sync/transactions"
  }
}
```

### PostgreSQL Is Required

The server refuses startup if `DATABASE_URL` is missing or blank. It does not start an incomplete in-memory application. Memory idempotency and offline-token components can still be tested independently. `/health` is a process-liveness/configuration response, not proof of database readiness, successful reconciliation or external settlement; production verification must check those separately.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port. Default `8787`. |
| `DATABASE_URL` | Required for the HTTP application's PostgreSQL-backed persistence. |
| `RAIL_API_KEY` | Shared secret for restricted routes such as offline token issue and sync. |
| `KYLR_API_KEY` | Legacy alias if `RAIL_API_KEY` is not set. |
| `JWT_SECRET` | JWT signing and verification secret. |
| `RAIL_SIGNING_SECRET` | HMAC signing secret for transaction and authorization integrity helpers. |
| `RAIL_EVIDENCE_KEY_RING` | Required HTTP-runtime JSON key ring for AES-256-GCM evidence and separate HMAC authentication. See the rotation/setup procedure in `DEPLOYMENT.md`. Never send it to clients. |
| `RAIL_ALLOWED_ORIGINS` | Comma-separated frontend origins allowed by CORS. Localhost development origins are used by default when unset. |
| `RAIL_REQUIRE_TX_SIGNATURE` | If `true`, execution paths require a valid `paymentSignature`. |
| `RAIL_RISK_MODEL_PATH` | Optional validated logistic-regression model JSON. Produces shadow observations only. |
| `RAIL_BEHAVIOUR_MODEL_PATH` | Optional expanded `behaviour-v1` artifact. Uses trusted historical features after financial locks; takes precedence over the legacy model, remains shadow-only. |
| `RAIL_REQUIRE_JSON_CONTENT_TYPE` | If not `false`, JSON routes require `Content-Type: application/json`. |
| `RAIL_REQUEST_BODY_TIMEOUT_MS` | Absolute body-read deadline for JSON routes. Default 10000 ms; slow/stalled uploads receive 408. |
| `RAIL_EXPOSE_INTERNAL_ERRORS` | If `true`, server responses expose internal error messages. |
| `RAIL_RATE_LIMIT_LOGIN_MAX` | Login attempts allowed in the configured login window. |
| `RAIL_RATE_LIMIT_LOGIN_WINDOW_MS` | Login rate-limit window in milliseconds. |
| `RAIL_RATE_LIMIT_AUTHORIZE_MAX` | Authorization requests allowed in the configured authorize window. |
| `RAIL_RATE_LIMIT_AUTHORIZE_WINDOW_MS` | Authorization rate-limit window in milliseconds. |
| `RAIL_RATE_LIMIT_EXECUTE_MAX` | Execute requests allowed in the configured execute window. |
| `RAIL_RATE_LIMIT_EXECUTE_WINDOW_MS` | Execute rate-limit window in milliseconds. |
| `RAIL_RATE_LIMIT_SYNC_MAX` | Sync requests allowed in the configured sync window. |
| `RAIL_RATE_LIMIT_SYNC_WINDOW_MS` | Sync rate-limit window in milliseconds. |
| `RAIL_RATE_LIMIT_TOKEN_ISSUE_MAX` | Offline-token issue requests allowed in the configured token window. |
| `RAIL_RATE_LIMIT_TOKEN_ISSUE_WINDOW_MS` | Offline-token issue rate-limit window in milliseconds. |
| `RAIL_AUTH_SWEEP_INTERVAL_MS` | Interval for expired authorization cleanup. |
| `RAIL_PKCS11_MODULE_PATH` | Unsupported: setting it fails startup. |
| `RAIL_KMS_KEY_ID` | Unsupported: setting it fails startup. |

---

## API Overview

### Owner-Controlled Agent Payments (V2.1)

These endpoints configure agent identities, spending policy and exact-request approvals, then execute approved online wallet transfers through the existing protected engine. Owner management requires a user JWT, not a wallet/service API key or agent credential. All owner control reads/writes share a PostgreSQL-backed limit of 20 requests per minute per owner, independent of source IP or agent ID. This is internal wallet accounting, not a live UPI or bank settlement connector.

| Endpoint | Purpose |
| --- | --- |
| `POST /v2/agents` | Create an owned agent using `{ "name": "Invoice assistant" }`. |
| `GET /v2/agents` | List the owner's agents. |
| `POST /v2/agents/:agentId/revoke` | Permanently revoke the agent through the API and revoke its credentials/mandates. Send `{}`. |
| `POST /v2/agents/:agentId/credentials` | Issue a random credential with optional `ttlSeconds` and explicit `scope`; its token is returned once. |
| `GET /v2/agents/:agentId/credentials` | List credential metadata without tokens or hashes. |
| `POST /v2/agents/:agentId/credentials/:credentialId/revoke` | Revoke one credential. Send `{}`. |
| `POST /v2/agents/:agentId/mandates` | Create a bounded, recipient-specific policy. |
| `GET /v2/agents/:agentId/mandates` | List policies and their active/expired/revoked status. |
| `POST /v2/agents/:agentId/mandates/:mandateId/revoke` | Revoke one policy. Send `{}`. |
| `GET /v2/agent/identity` | Validate an agent token in `Authorization: Bearer <token>`; limited to 30 requests/minute per request source. |
| `POST /v2/agent/intents` | Propose a fingerprint-bound request using an agent credential; reserve mandate budget, not wallet funds. |
| `GET /v2/agent/intents` | List that agent's retained intents and release elapsed holds. |
| `POST /v2/agent/intents/:intentId/execute` | Execute an approved intent with an execution-scoped credential and its exact fingerprint. |
| `GET /v2/agents/:agentId/intents` | Owner-only approval queue and retained history. |
| `POST /v2/agents/:agentId/intents/:intentId/decision` | Owner-only `approve` or `reject` decision bound to `requestFingerprint`. |

Credential scope defaults to `payments:propose`, which cannot execute payments. The owner must explicitly request `payments:execute` to grant execution authority; existing credentials are not upgraded by migration. Execution credentials can also propose and inspect intents. Issuance and execution fail closed unless the engine supports durable transactional replay and required evidence, and `RAIL_SIGNING_SECRET` contains at least 32 non-padding characters after trimming. Use securely generated material, not a human password. Default expiry is 24 hours; supplied lifetimes must be 60 seconds to 30 days. Only a SHA-256 hash of the 256-bit random token is persisted. Capture the one-time token response securely, never in browser storage or application logs. If the response is lost, inspect credential metadata, revoke that credential and issue a replacement; issuance itself is not an idempotent payment operation.

Example mandate body:

```json
{
  "mode": "budgeted",
  "currency": "INR",
  "perPaymentLimitMinor": 2500,
  "totalBudgetMinor": 10000,
  "allowedReceiverWalletIds": ["receiver_wallet"],
  "ttlSeconds": 86400
}
```

`approval_required` is the other supported mode. Amounts use minor units, the per-payment limit cannot exceed the total budget, and 1-20 distinct receivers must already exist in the owner's currency. Self-payment policies are rejected. Intents start `pending` in approval-required mode and `approved` under a budgeted mandate. Approval cannot override the policy. Neither creating a policy nor approving an intent reserves wallet funds. There is no unrestricted mode. `executionEnabled` describes runtime/state capability, not proof of credentials, funds or permission; execution rechecks them transactionally.

Example proposal to `POST /v2/agent/intents`:

```json
{
  "mandateId": "<mandate UUID>",
  "clientRequestId": "invoice_request_001",
  "receiverWalletId": "receiver_wallet",
  "amountMinor": 2500,
  "currency": "INR",
  "ttlSeconds": 300
}
```

The response contains `{ "intent": { ... } }`, including the immutable `requestFingerprint`, `status`, deadline and capability flag. The owner posts `{ "decision": "approve", "requestFingerprint": "<returned fingerprint>" }` to the decision endpoint. Use `reject` to release an unexecuted hold, including a previously approved hold. Rejected/expired intents cannot be revived. Executed intents retain their receipt and consumed budget; a later rejection cannot refund money or restore budget. Inspect the returned status rather than assuming a repeated decision succeeded.

`clientRequestId` is 8-128 characters and unique within an agent. Identical retries return the existing intent without another hold or a renewed deadline; a changed mandate, receiver, amount, currency or TTL returns `409`. TTL defaults to 300 seconds, accepts 60-900 seconds and is clipped to the mandate deadline. The approval fingerprint binds the exact owner, agent, mandate, recipient, amount, currency and timestamps.

Pending and approved intents hold `reservedBudgetMinor`; executed intents consume `spentBudgetMinor`. PostgreSQL commit constraints require each counter to equal its corresponding intent sum, with held plus spent not exceeding `totalBudgetMinor`. This is policy headroom, not proof of available wallet money. Intent/mandate reads and intent mutations lazily release expired holds in a successful audited transaction; there is no intent expiry worker. A failed operation rolls that cleanup back. Revoking an agent or mandate releases unexecuted holds, not spent budget; revoking one credential prevents subsequent token use but does not cancel every intent belonging to the agent.

Send only `{ "requestFingerprint": "<returned fingerprint>" }` to the agent execution endpoint with an execution-scoped bearer token. Extra money or recipient fields are rejected. The server constructs the transaction from the immutable intent, creates a bound authorization and signs it with the server-only HMAC secret. It uses `executeInTransaction`, `createAuthorizationInTransaction` and PostgreSQL `dedupeInTransaction` on one client. Authorization, wallet/ledger changes, evidence, replay, budget consumption, executed-intent linkage and audit events commit together. Failed work rolls back; the HTTP receipt is returned only after final `COMMIT`, including deferred checks.

Successful responses contain `{ "intent": { ... }, "result": { ... } }`; the executed intent includes `paymentTxId` and `executedAt`. Concurrent retries return the original committed result without another transfer or evidence record. Live execution credentials, agent and mandate authority are required even for replay; after revocation, owners can still inspect retained history. `rail_agent:` transaction IDs and `rail_agent_intent:` replay keys are reserved for this server-generated path. Agent execution is online-only; existing device-bound offline/reconnect processing is unchanged.

```mermaid
flowchart TD
  Owner[Owner JWT] --> Mandate[Recipient and budget policy]
  Mandate --> Proposal[Agent proposes immutable intent]
  Proposal --> Mode{Mandate mode}
  Mode -->|Approval required| Decision[Owner approves exact fingerprint]
  Mode -->|Budgeted| Approved[Approved intent with policy hold]
  Decision --> Approved
  Approved --> Guard[Execution credential and live authority checks]
  Guard --> Atomic[One database transaction: payment, evidence, replay, budget and audit]
  Atomic --> Commit{Final commit}
  Commit -->|Success| Receipt[Committed receipt or identical replay]
  Commit -->|Failure| Rollback[Rollback all changes; no success receipt]
```

The coordinator locks both wallets in sorted order and does not sweep unrelated expired wallet authorizations inside that lock scope. Existing authorization reads/sweeps release those reservations separately; policy headroom does not guarantee immediately available wallet funds. This implementation has local regression coverage, not hosted or real-money acceptance.

Agent intent reads/writes share a PostgreSQL-backed 20/minute agent bucket across credentials and IP addresses, plus a 30/minute source bucket. Limits are 50 retained agents per owner, 100 credentials/mandates and 1,000 intents per agent, including revoked, rejected or expired rows. No automatic deletion resets these bounds. Intent bindings/history cannot be edited or deleted through normal SQL updates. Mutations and audit events commit together; failed audit writes roll changes back. Apply migrations before updating hosted API instances. Pending intent fields are relational data, not encrypted payment evidence; the AES/HMAC evidence path below applies to committed payments.

### `GET /v1/payments/:txId/risk`

Authenticated sender/receiver access to the payment's retained shadow assessment. The response contains observation time, policy version, explanation codes, model availability/version and synthetic-data status, not raw history, feature values or inference probabilities. Unknown and inaccessible payments both return 404. Reads use a 30/minute wallet/source bucket and `Cache-Control: no-store`. Older payments without snapshots return `legacy_unobserved`, not an invented score.

New payments using the standard pipeline retain one immutable, fingerprint-bound observation in the financial transaction. Collection occurs after authority/token checks and sorted wallet locks, before posting the current payment. It uses database time and up to 1,000 prior visible payments from the last 30 days in the same wallet/currency. Truncated history is explicit; sampled five-minute velocity is a lower bound and recipient familiarity is sample-local. Cold start and missing device-verification history are not treated as proof of safety. Agent budget exposure comes from persisted held plus spent budget, not agent claims.

The versioned deterministic policy reports amount deviation, velocity and budget pressure for explanation only. `review` is a shadow observation, not a suspended payment; `normal` does not mean fraud-free. Optional `RAIL_BEHAVIOUR_MODEL_PATH` enables expanded logistic inference from trusted features, with named log-odds contributions and explicit missing-history/budget indicators. The legacy amount/channel artifact remains supported. Model hashes and predictions are retained privately; a future training cutoff returns `not_yet_valid` without silently falling back to another model. Observation writes and required-observation commit checks must succeed with payment accounting; retry returns the same snapshot rather than rescoring history. Feature records are relational data, not part of the encrypted transaction envelope. Real-label validation, retention/privacy approval, drift monitoring and production fraud enforcement remain open.

`npm run risk:monitor -- /private/path/cohorts.json` compares chronological reference/current cohorts with the expanded model. It reports aggregate feature/prediction shifts and missingness, not individual transactions or fraud accuracy. Exit codes are 0 for no detected shift, 2 for detected shift, 3 for insufficient samples and 1 for invalid input. This offline diagnostic does not auto-retrain or change payments; threshold validation, independently reviewed inputs, protected risk-record retention and live operational acceptance remain required.

### `GET /v1/payments/:txId/evidence`

Authenticated sender/receiver access to committed payment evidence status. Returns `verified` with a ciphertext commitment, `legacy_unprotected` for historical payments without evidence, or `verification_unavailable` with a safe reason. Unknown and inaccessible payments both return `404`. Reads are limited to 30 per minute per wallet and request-source bucket; responses use `Cache-Control: no-store`.

New HTTP-runtime payments commit AES-256-GCM evidence and independently keyed HMAC-SHA256 in the same transaction as wallet, token, ledger, event and replay state. Retries do not regenerate the evidence. This protects the canonical audit copy, not every relational field or event payload. HMAC is server-side authentication, not a public digital signature. Historical payments are not automatically backfilled, and no blockchain is deployed by this feature.

### `POST /auth/register`

Creates a user and a matching wallet identity.

Notes:

- passwords are hashed with `bcryptjs`
- registration is transactional
- duplicate users return a conflict-style error instead of a generic server failure

### `POST /auth/login`

Authenticates a user and returns a JWT.

Notes:

- login failures return a generic invalid-credentials response
- login is rate limited per IP and per account across IPs (default five attempts per 15 minutes); account identifiers are hashed in quota keys
- successful attempts count toward the same bounded quota; this temporary throttle is not an adaptive fraud engine or permanent account lockout
- JWTs carry the stored credential version and expire after 15 minutes; tokens issued before this versioned-token change require a fresh login

### `POST /auth/logout-all`

Send `Authorization: Bearer <token>`. Rail atomically increments the user's credential version, returning `{ "ok": true, "sessionsRevoked": "all" }`. Previously issued bearer tokens fail subsequent authentication across instances, including stream rechecks. The caller must log in again. This does not revoke API keys or cancel a payment already authenticated and executing; uncertain payment responses must be retried with the original idempotency key.

Password recovery and operator credential resets must also increment this version. No public password-reset flow is implemented in V1; do not expose a manual database reset operation to client applications.

### `POST /v1/payments/authorize`

Creates a payment authorization and reserves sender funds.

Expected fields:

- `txId`
- `senderWalletId`
- `receiverWalletId`
- `amountMinor`
- `currency`

Important behavior:

- caller identity must match `senderWalletId`
- authorization is persisted server-side
- the authorization returned to the client corresponds to stored state

### `POST /v1/offline/tokens/issue`

Issues device-bound offline spend headroom while the client is online.

Expected fields:

- `walletId`
- `deviceId`
- `amountCapMinor`
- optional `currency`
- optional `ttlSeconds`

### `POST /v1/payments/execute`

Executes a single payment through the hardened pipeline.

Required transaction fields include:

- `txId`
- `idempotencyKey`
- `authorizationId`
- `senderWalletId`
- `receiverWalletId`
- `amountMinor`
- `currency`
- `channel`
- `createdAt`

Offline transactions must also include:

- `offlineTokenId`
- `deviceId`

Important behavior:

- `authorizationId` must reference a stored server-issued authorization
- transaction data must match the stored authorization
- same-key completed retries are allowed safely
- reused authorizations with a different request identity are blocked

### `POST /v1/sync/transactions`

Replays queued offline transactions in FIFO order.

Rules:

- sync accepts offline transactions only
- every item must include `authorizationId`
- every transaction `deviceId` must match the outer request `deviceId`
- the route is API-key protected

### `GET /v1/events`

Returns committed wallet-visible events for the authenticated caller. Use `?limit=20` (1-100) and `?before=<nextBefore>` for older pages. The response contains `events` and `nextBefore`; each event has a stable string `id`. Wallet filtering happens in PostgreSQL before the limit, so other wallets cannot crowd out your history.

Pages are ordered by database event ID, not client timestamps. Refresh the first page when reconnecting and deduplicate by ID: IDs are allocated before commit, so a page cursor is not a guaranteed live-delivery watermark. The feed is not a settlement confirmation.

### `GET /v1/events/stream`

Streams committed wallet-visible snapshots over SSE on persistent servers. The server polls shared PostgreSQL rows every two seconds, rechecks credentials, and closes connections after 60 seconds or on write backpressure. Admission is limited to two connections per wallet and 64 per process. Event requests are rate-limited (60 REST reads or six stream starts per minute per wallet/IP).

SSE is an advisory UI feed, not a durable subscription. It samples the latest 100 wallet events and can miss bursts above that window; clients must refresh and page REST history to recover, deduplicating by event ID. `Last-Event-ID` does not provide guaranteed replay. Multi-instance deployment needs provider-level connection/resource limits as well as these local caps. Serverless runtimes use REST polling only.

Frontend note:

- regular clients can use `Authorization: Bearer <token>`
- use authenticated `fetch` streaming when custom headers are required, or poll `GET /v1/events`
- query-string credentials are not accepted; hosted serverless runtimes disable SSE

---

## Request and Diagnostic Bounds

JSON bodies are size-limited and have an absolute read deadline. Oversized requests receive 413; stalled bodies receive 408. Both responses close the connection after flushing the JSON error, rather than destroying the socket before the client can read it. Reverse proxies still need independent header, connection and upload limits.

Development memory stores are bounded: idempotency retains at most 10,000 records and refuses new keys when full, never evicting successful replay results to admit another payment. The memory rate limiter caps identities and denies new ones until expired entries can be reclaimed. The memory diagnostic DLQ keeps the latest 1,000 entries and is not an audit log or delivery queue; durable delivery failures live in the PostgreSQL outbox. Database replay/token retention must be designed separately before pruning financial records.

## Event Model

The backend emits operational and business events that can be used for dashboards, observability, or future integrations.

Examples include:

- pipeline stage progression
- pipeline failures
- ledger-posted events
- other wallet-relevant execution activity

Current event visibility rules:

- event routes require authentication
- users only see events relevant to their wallet
- API-key callers only see events relevant to the wallet bound to that key
- raw `system.error` events are not exposed through the client-visible event feed
- browser access is restricted by explicit allowed origins instead of wildcard CORS

---

## Selected Source Layout

```text
src/
  auth/
    jwt.ts
  crypto/
    authorizationSigning.ts
    transactionSigning.ts
  domain/
    authorization.ts
    types.ts
  persistence/
    migrate.ts
    postgresIdempotency.ts
    postgresOfflineTokenStore.ts
    postgresPool.ts
  pipeline/
    engine.ts
    idempotency.ts
    outbox.ts
    tracing.ts
  rail/
    offlineTokenStore.ts
    syncBatch.ts
  server/
    server.ts
    authentication.ts
    config.ts
    events.ts
    http.ts
    types.ts
    validation.ts
    routes/
      authRoutes.ts
      eventRoutes.ts
      paymentRoutes.ts
  stages/
    authorizationStage.ts
    paymentPipeline.ts
```

---

## Scripts

| Script | Command |
|---|---|
| Build | `npm run build` |
| Tests | `npm test` |
| Deliver outbox batch | `npm run outbox:dispatch` |
| Release expired authorizations | `npm run authorizations:sweep` |
| Check accounting consistency | `npm run accounting:reconcile` |
| Train risk baseline | `npm run risk:train -- dataset.json model.json` |
| Run server | `npm run server` |
| Isolated demo script | `RAIL_DEMO_MODE=true npm run demo` |

`RAIL_DEMO_MODE=true npm run demo` follows the authorization-first flow. It requires a non-production environment, `DATABASE_URL`, `RAIL_SIGNING_SECRET`, and database permissions to create/drop a schema. Use a development database and maintenance credentials, not production runtime credentials.

Each invocation creates a random isolated schema, seeds synthetic opening funds there, creates an authorization, executes an online payment, replays the exact request and checks reconciliation. It prints acceptance results and balances, then removes only its own temporary schema and closes its pools. Repeated runs do not claim existing wallets or reuse stale payment fingerprints. This proves the internal demo flow, not external bank settlement or production readiness.

Schedule `npm run authorizations:sweep` outside the API process for unattended expiry cleanup. Each run releases at most 1,000 expired reservations; repeat runs drain larger backlogs. Reads and new authorizations also reclaim expired reservations transactionally. Serverless instances do not start background timers. Keep database credentials in the scheduler's secret storage and monitor failed runs.

`npm run accounting:reconcile` is read-only and exits nonzero if it finds problems. It compares available plus reserved funds with the recorded opening balance plus ledger movements, and reserved funds with issued authorizations. It also checks currency, usage, execution and replay consistency in one database snapshot. Reports are bounded; a truncated report is explicitly incomplete, not a clean result.

New wallets record their initial balance; registration starts at zero. This is an accounting baseline, not proof of external funding or settlement. Historical wallets are not automatically backfilled, and money mutations without a baseline fail with `503 accounting_review_required`. An operator must review source records first. With separate maintenance credentials and `RAIL_ACCOUNTING_OPERATOR=true`, the command `npm run accounting:reconcile -- --record-opening WALLET_ID AMOUNT_MINOR EVIDENCE_REFERENCE` records an independently reviewed value once. Unresolved wallet-related findings or an incorrect balance prevent the record from committing. The reference is stored for review; Rail cannot verify the external evidence itself. Do not change wallet balances directly to add funds; a formal funding/reversal lifecycle is still unfinished.

---

## Current Limitations

This project is much stronger than a toy payment demo, but it is still honest to call out what is not finished yet.

Current limitations include:

- durable webhook delivery needs a scheduled worker and a receiver that deduplicates event IDs; SSE is advisory and requires REST recovery
- API keys are still an area that can be hardened further
- memory components are test utilities, not a supported HTTP runtime
- no enforced fraud policy is implemented; optional ML remains in shadow mode and needs validated labeled data
- documentation and demo flows need to be kept aligned as the project evolves

These gaps are tracked more fully in [PROJECT_STATUS_REPORT.md](./PROJECT_STATUS_REPORT.md).

---

## License

Licensed under AGPL-3.0-only. See [LICENSE](../LICENSE).

---

## Disclaimer

Rail is infrastructure software for learning, architectural exploration, and controlled backend experimentation. It does not by itself satisfy regulatory, settlement, reconciliation, or compliance requirements for real-money production deployment.
