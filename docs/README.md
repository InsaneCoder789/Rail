![Rail: Payments with permission. Offline-aware, retry-safe, owner-controlled.](assets/rail-banner-v2.png)

# Rail

**Owner-controlled payment execution for AI agents, with human payments on the same accounting foundation.**

[![Rail CI](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml/badge.svg)](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../LICENSE)

Rail started with a question: how should a payment backend behave when connectivity disappears, requests repeat, or a process fails halfway through a transfer?

The answer is not another transfer endpoint. It is a controlled execution path: permission before spending, durable accounting, one committed result for an identical retry, and evidence of what actually happened. Rail's main direction is now delegated AI-agent payments: an agent can request a transfer, but cannot grant itself spending authority. Owners define recipients, budgets, expiry and exact-request approvals. Human payments and the original offline-aware foundation remain supported.

**PostgreSQL is the financial source of truth. ML supplies shadow risk observations, not spending authority. Audit proofs establish local inclusion, not bank settlement.** Rail does not replace UPI, card networks or PSPs, and has no live settlement connector. It is an engineering project with tested internal guarantees and explicit production-release gates.

[Runtime flow](#runtime-flow) / [Offline boundaries](#offline-boundaries) / [Agent payments](#agent-payments) / [Run locally](#run-locally) / [API](#api) / [Documentation](#documentation)

## What Is Implemented

| Area | Current behavior |
| --- | --- |
| Payment authority | Persisted, signed authorizations bind the transaction, wallets, amount, currency and expiry; issuance reserves available funds. |
| Transaction safety | Execution coordinates authorization use, token accounting, wallets, ledger, risk, evidence, events and replay through one PostgreSQL transaction. |
| Retry protection | Durable idempotency binds a key to a canonical request fingerprint and committed result; changed payloads cannot reuse that key. |
| Offline foundation | Wallet/device/currency-bound tokens, bounded spend headroom and reconnect synchronization through the same execution engine. |
| Agent control | Owner-managed identities, hashed expiring credentials, immutable authority policies and intents, permanent revocation and atomic budget consumption. |
| Protected records | Required HTTP payment evidence and detailed risk records use independently keyed AES-256-GCM and HMAC-SHA256 envelopes. |
| Risk diagnostics | Optional behavioural logistic regression, robust median/MAD anomaly assessment and bounded offline drift diagnostics. All remain shadow-only. |
| Audit evidence | Durable pending queue, verified Merkle batches, immutable inclusion proofs and participant-only reads. Roots remain unanchored. |
| Event delivery | Transactional outbox with leases, retries, acknowledgement and dead letters; wallet-scoped REST history and advisory SSE on persistent servers. |
| Operational checks | Accounting reconciliation, authorization expiry cleanup, bounded request parsing and shared source/identity quotas. |

The latest backend verification passed **249 tests with zero failures or skips**, including real PostgreSQL integration tests, on 12 October 2026. The badge links to live CI results; that local count is not a statement that every future revision or deployment has passed. The suite includes concurrent requests, response-loss recovery, backend termination, policy tampering, revocation races and failed final commits.

## Runtime Flow

The HTTP layer authenticates the caller and validates the request. The engine and persistence layer enforce the financial invariants again inside the transaction; correctness does not depend on a route handler having remembered every check.

```mermaid
flowchart TD
    Caller["Person / application / trusted service"] --> Gate["Source quota, authentication and identity quota"]
    Gate --> Authorize["Authorize exact transfer and reserve funds"]
    Authorize --> Execute["Execute with authorization ID and idempotency key"]
    Sync["Reconnect: queued offline requests"] --> Execute
    Agent["Approved agent intent"] --> Execute
    Execute --> Transaction["One PostgreSQL execution transaction, including replay check"]
    Transaction --> Replay{"Matching committed replay?"}
    Replay -->|Yes| Original["Commit replay transaction; return original result without another transfer"]
    Replay -->|No| Checks["Claim authority, lock wallets, check offline bindings and collect trusted risk features"]
    Checks --> Writes["Wallets, ledger, protected records, outbox, replay and audit pending job"]
    Writes --> Commit{"Final commit succeeds?"}
    Commit -->|Yes| Receipt["Return accepted internal payment receipt"]
    Commit -->|No| Rollback["Roll back execution effects; retry or resolve the error"]
    Receipt --> Workers["Separate event-delivery and audit-batching jobs"]
```

### Authorization and Accounting

Amounts are validated integer minor units: INR 300 is `30000`, not a floating-point `300.00`. In Rail, wallet `balance` means available funds and `reserved` means held funds.

| Example: INR 1,000 available, authorize INR 300 | Available | Reserved |
| --- | --- | --- |
| Before authorization | 1,000 | 0 |
| Authorization issued | 700 | 300 |
| Payment executed | 700 | 0 |
| Unused authorization expires instead | 1,000 | 0 |

Execution credits the receiver and posts a matching debit/credit ledger pair. Database uniqueness, foreign keys, immutable posted history and deferred commit guards complement application validation. Reconciliation checks recorded accounting baselines, ledger movements and reservations in a consistent snapshot.

Ordinary authorization creation precedes the execution transaction. Failed execution restores the state at execution start; it does not erase that earlier reservation. Retry or expiry resolves it. Agent execution composes authorization creation into its larger transaction with the intent and budget writes.

### Retry and Crash Recovery

The canonical fingerprint includes transaction and authorization IDs, wallets, amount, currency, channel, offline bindings, creation time and idempotency key. Versioned JSON encoding avoids ambiguous delimiter-based signatures.

- Same key and canonical payment: return the stored committed result.
- Same key with changed payment data: reject the request.
- Concurrent identical requests: coordinate through transaction-scoped database locks.
- Failure before commit: execution effects and replay writes roll back together.
- Commit succeeds but the response is lost: retry the original payload/key to recover its result.

This is an effectively-once internal financial effect, not a promise of exactly-once network delivery. Never change the key merely because a response timed out.

## Offline Boundaries

Rail preserves its original offline-aware scope. A privileged service can issue a bounded token while online; later synchronization validates wallet, device, currency, token headroom and stored authorization before posting a payment. Token reservations/finalization share the financial transaction and cannot be refunded repeatedly through rollback.

The important boundary: **a token is not a blanket permission to spend, and an offline attempt is not confirmed settlement.** Exact payment authorizations must already exist and remain usable. Sync accepts offline channels only, checks the outer device binding, and processes items in order with individual outcomes rather than one all-or-nothing batch commit.

`nfc`, `ble` and `qr` are supported transaction channel values. This repository does not implement mobile transport, secure device storage, hardware attestation or a protocol proving final settlement while both devices are disconnected. Device-ID matching is a backend binding, not proof that a physical device is uncompromised. There is no NPCI, USSD, IVR or bank connector.

## Agent Payments

An agent receives its own scoped credential, not the owner's login or a server encryption key. Owners manage agents using a current user JWT. Random credentials are stored as hashes, expire and can be revoked; proposal-only credentials cannot execute payments.

```mermaid
flowchart LR
    Owner["Owner"] --> Mandate["Recipient, currency, payment limit, total budget and expiry"]
    Mandate --> Proposal["Agent proposes an immutable intent"]
    Proposal --> Mode{"Mandate mode"}
    Mode -->|approval_required| Review["Owner decision bound to exact fingerprint"]
    Mode -->|budgeted| Preapproval["Preapproval within existing policy"]
    Review --> Authority["Recheck live credential, agent, mandate, expiry and funds"]
    Preapproval --> Authority
    Authority --> Commit["Commit payment, spent budget, executed intent and audit together"]
```

Pending/approved intents hold mandate budget, not wallet funds. Execution consumes that held policy allowance only with the committed payment. Expiry, rejection and revocation release unexecuted holds; they do not restore already spent budget. Approvals cannot override recipient/currency/budget restrictions, and changing a request invalidates its fingerprint. Agent execution is online-only and requires explicit `payments:execute` scope. Fresh execution and agent replay both check live authority.

Stored owner/agent bindings, credential scopes and deadlines, and mandate policies reject ordinary SQL updates and deletes. Revocation is one-way; changing permissions requires a new owner-created credential or mandate. Budget counters remain constrained by the associated intents and committed executions. These guards are defense in depth, not protection against a database administrator disabling them.

`approval_required` means an owner decision for the exact request. `budgeted` means advance owner permission within fixed limits, not a new human acknowledgement for every transfer. Never give an agent an owner JWT, privileged service key, database access or server signing keys. Rail authorizes software callers; it does not prove a human was physically present or prevent a compromised operator from changing application code. See the [agent security boundaries and implementation roadmap](AGENT_PAYMENT_SECURITY.md).

## Risk and Protected Evidence

### Explainable Intelligence, Without Payment Authority

Trusted behavioural observations use committed wallet history and persisted agent exposure inside the financial transaction. History is bounded to a 30-day window and up to 1,000 samples. Features include recent velocity, amount deviation, recipient familiarity, budget exposure and explicit missing-history indicators; verified device-change detection is not implemented.

The expanded logistic model uses ten vector entries including its intercept. Training supports chronological training/validation/test splits, label-availability guards, artifact provenance and held-out calibration/ranking metrics. An optional median/MAD reference baseline measures unusualness alongside logistic inference. Offline drift checks report aggregate distribution changes and insufficient-data states.

Models are optional and validated before runtime startup. Wrong currency, future cutoffs and insufficient anomaly history produce explicit unavailable states rather than invented certainty. Detailed predictions remain encrypted; completed replay retains the original observation. A `review` reason is a shadow diagnostic, not an enforced challenge. Synthetic fixtures demonstrate mechanics, not real-world fraud accuracy. No default production model, automatic retraining or live drift scheduler is supplied.

### Confidentiality and Integrity

The HTTP runtime requires separate payment-evidence and risk-record key rings. AES-256-GCM protects the records; independently keyed HMAC-SHA256 authenticates each versioned envelope. Trusted transaction/purpose bindings reject records attached to the wrong payment. Retained key versions support verification after rotation; missing keys or tampering return unavailable verification, not a successful audit.

These are server-side symmetric keys, not client signing credentials or public-key signatures. GCM already authenticates ciphertext; the separate HMAC adds an explicit envelope-verification layer. Incoming transaction HMAC enforcement is a distinct configurable check. Relational financial fields, pending intents and remaining lifecycle events are not encrypted by these evidence envelopes. KMS/HSM custody and independently verified production restore remain release gates.

## Audit Proofs

```mermaid
flowchart LR
    Evidence["Protected evidence committed with payment"] --> Pending["Durable pending audit job"]
    Pending --> Verify["Authenticate selected payment and required risk records"]
    Verify --> Batch["Build bounded Merkle root and proofs"]
    Batch --> Store["Atomically persist immutable membership and consume jobs"]
    Store --> Participant["Participant-only locally verified inclusion proof"]
    Store -. "Future work, not deployed" .-> Chain["Independent chain publication and finality tracking"]
```

The finite `audit:batch` worker handles 1-256 pending records per run, default 128. It does not run inside a payment request. Missing historical keys or corrupt records stop batching instead of silently omitting evidence. Participant reads disclose only that payment's commitments, inclusion path and batch metadata after verification.

**Current proof status is local-only and unanchored.** No contract, signer, publisher, finality/reorg tracker or independent checkpoint has been implemented. Inclusion does not establish complete historical coverage, truthful original inputs or external settlement.

The planned blockchain role is independently checkable evidence after execution, not permission to spend. Current audit leaves bind protected payment and risk commitments; they do not yet cryptographically bind the full mandate policy or owner-decision provenance. Those authority receipts must be implemented before claiming blockchain-verifiable owner controls.

## Run Locally

The HTTP application requires PostgreSQL; memory components are isolated test/library utilities, not another server mode. CI covers Node.js **22 and 24** with **PostgreSQL 16**. Use a development database, npm, and optionally Docker Compose.

### 1. Install and Start PostgreSQL

```bash
git clone https://github.com/InsaneCoder789/Rail.git
cd Rail
npm ci
docker compose up -d postgres
```

Docker Compose uses `rail` / `rail_dev_password` and database `rail` on port 5432. Those are local development credentials only. If using another PostgreSQL instance, configure its connection string instead.

### 2. Configure Private Runtime Values

Copy `.env_example` to `.env` only if you do not already have a local configuration. Replace its demonstration secrets; they are not suitable runtime keys. At minimum configure:

```dotenv
PORT=8787
DATABASE_URL=postgresql://rail:rail_dev_password@127.0.0.1:5432/rail
JWT_SECRET=<independent securely generated secret>
RAIL_SIGNING_SECRET=<independent securely generated secret>
RAIL_API_KEY=<independent securely generated service key>
RAIL_API_KEY_SCOPES=offline_tokens:issue,sync:write
RAIL_ALLOWED_ORIGINS=http://localhost:3000
RAIL_TRUST_PROXY_HEADERS=false
RAIL_EVIDENCE_KEY_RING=<private payment key-ring JSON>
RAIL_RISK_RECORD_KEY_RING=<independent private risk key-ring JSON>
```

Angle-bracket values are placeholders, not runnable configuration. Generate independent random secrets, for example with `openssl rand -base64 32`. Each key ring needs its own 32-byte AES key and different 32-byte HMAC key encoded as base64; use the JSON shape and rotation procedure in [DEPLOYMENT.md](DEPLOYMENT.md). Agent execution requires a signing secret with at least 32 non-padding characters. Never commit secrets, print them in CI or distribute server keys to clients. No model artifact is required to start the server.

### 3. Migrate, Start and Check Liveness

```bash
npm run migrate
npm run server
```

In another terminal:

```bash
curl -s http://127.0.0.1:8787/health
```

Local startup can also initialize the schema; explicit migrations are the release step for hosted runtimes. `/health` reports liveness/configuration, not database readiness, reconciliation acceptance or settlement. Registration creates a zero-funded wallet. Do not edit balances to manufacture funds: the external funding/reversal lifecycle is unfinished.

### 4. Test or Demonstrate Safely

```bash
DATABASE_URL=postgresql://rail:rail_dev_password@127.0.0.1:5432/rail npm test
RAIL_DEMO_MODE=true RAIL_REQUIRE_TX_SIGNATURE=false npm run demo
```

Use development credentials with schema create/drop permissions for integration tests and the demo, not production runtime credentials. PostgreSQL tests skip if `DATABASE_URL` is absent, so a passing unit-only run is not full integration verification. The demo requires a non-production environment, `DATABASE_URL` and `RAIL_SIGNING_SECRET`. Its signature override applies only to that isolated invocation, not the running HTTP server.

The demo creates a fresh temporary schema, seeds synthetic opening funds, authorizes and executes an online payment, repeats it, checks balances/reconciliation, then removes only its own schema. It demonstrates the core financial/replay path; it does not exercise every protected V2 HTTP feature or an external settlement provider. The complete test suite covers those implemented V2 integrations separately.

## API

JSON writes require `Content-Type: application/json` by default. Use credentials in headers, never query strings. User JWTs map to their stored wallet and credential version; database wallet API keys are a separate existing mechanism. The configured privileged service key is not a user's wallet credential and must stay on a trusted backend.

| Method and endpoint | Purpose / authority |
| --- | --- |
| `GET /health` | Public process-liveness/configuration response. |
| `POST /auth/register` | Create a user and a new zero-funded wallet. |
| `POST /auth/login` | Obtain a bounded-lifetime user JWT. |
| `POST /auth/logout-all` | Advance credential version; invalidate prior JWTs on subsequent authentication. |
| `POST /v1/payments/authorize` | Authenticated sender requests an exact authorization and fund reservation. |
| `POST /v1/payments/execute` | Authenticated sender executes/replays a bound transaction. |
| `POST /v1/offline/tokens/issue` | Service key with `offline_tokens:issue` issues bounded device headroom. |
| `POST /v1/sync/transactions` | Service key with `sync:write` processes queued offline requests. |
| `GET /v1/payments/:txId/evidence` | Sender/receiver reads verified evidence status, not decrypted payment data. |
| `GET /v1/payments/:txId/risk` | Sender/receiver reads authenticated explanation/model-availability summaries. |
| `GET /v1/payments/:txId/audit` | Sender/receiver reads local inclusion proof/status. |
| `GET /v1/events` | Wallet-filtered committed history with `limit` and `before` pagination. |
| `GET /v1/events/stream` | Authenticated advisory SSE on persistent servers; disabled in serverless mode. |
| `POST /v2/agents`, `GET /v2/agents` | Owner JWT creates/lists owned agents. |
| `POST /v2/agents/:agentId/revoke` | Owner JWT revokes an agent and its credentials/mandates. |
| `POST`, `GET /v2/agents/:agentId/credentials` | Owner JWT issues a one-time credential or lists safe metadata. |
| `POST /v2/agents/:agentId/credentials/:credentialId/revoke` | Owner JWT revokes one credential. |
| `POST`, `GET /v2/agents/:agentId/mandates` | Owner JWT creates/lists spending policy. |
| `POST /v2/agents/:agentId/mandates/:mandateId/revoke` | Owner JWT revokes a mandate. |
| `GET /v2/agent/identity` | Validate a distinct agent credential. |
| `POST`, `GET /v2/agent/intents` | Agent proposes/lists its intents. |
| `GET /v2/agents/:agentId/intents` | Owner JWT reads the approval queue/history. |
| `POST /v2/agents/:agentId/intents/:intentId/decision` | Owner JWT approves/rejects the exact fingerprint. |
| `POST /v2/agent/intents/:intentId/execute` | Execution-scoped agent submits the approved fingerprint. |

An authorization request contains `txId`, `senderWalletId`, `receiverWalletId`, `amountMinor` and `currency`. Execute adds `idempotencyKey`, the returned `authorizationId`, `channel` and `createdAt`; offline execution also requires `offlineTokenId` and `deviceId`. `paymentSignature` is required when incoming HMAC enforcement is enabled. Preserve the original canonical request when retrying.

For mandate/intent bodies, dataset contracts, capacities, approval modes and key behavior, see [V2_TECHNICAL_GUIDE.md](V2_TECHNICAL_GUIDE.md). Unknown routes return 404. An accepted receipt means the internal financial commit succeeded, not that a bank transfer settled.

## Security and Operations

PostgreSQL quotas apply independently to the request source and trusted identity. Malformed requests count; changing IP does not reset a wallet/owner/agent allowance. Token issuance and sync use a stable single configured-service allowance, not caller-selected body identifiers. Existing defaults are deliberately strict: authorize 12/minute, execute 20/minute, issue/sync 6/10 minutes per route, login 5/15 minutes. Review service-wide capacity before multi-user deployment. Allowed frontend origins can read quota and `Retry-After` headers; CORS is not authentication.

Forwarded headers are trusted only through explicit configuration with a sanitizing proxy. Shared NAT clients and targeted accounts can still experience throttling. Database bucket retention and edge connection/DDoS controls are separate operational requirements. Production configuration rejects missing/weak required secrets and unsuitable frontend origins. JSON size/deadline bounds and bounded local diagnostic stores limit resource use.

Outbox delivery is at least once: receivers must durably deduplicate stable delivery IDs before acknowledging. Leases/retries recover worker failure; exhausted attempts remain dead-lettered for review. SSE samples committed events with credential rechecks and bounded connections/lifetime, but can miss bursts. Recover through REST history and deduplicate IDs; SSE is not a settlement receipt or durable subscription.

| Command | Responsibility |
| --- | --- |
| `npm run build` | Clean output and compile TypeScript. |
| `npm test` | Compile and run unit/integration tests. |
| `npm run migrate` | Apply database/runtime and outbox migrations. |
| `npm run server` | Start the persistent local HTTP runtime. |
| `npm run outbox:dispatch` | Deliver a finite batch to a configured trusted HTTPS webhook. |
| `npm run authorizations:sweep` | Release a bounded set of expired reservations. |
| `npm run accounting:reconcile` | Read-only accounting review; findings exit nonzero. |
| `npm run audit:batch` | Verify and persist a finite local audit batch. |
| `npm run risk:train -- dataset.json model.json` | Train/evaluate a supported private risk/anomaly artifact. |
| `npm run risk:monitor -- cohorts.json` | Run bounded offline drift diagnostics. |

Schedule and monitor finite maintenance commands explicitly; their existence does not install workers or alerts. The Vercel adapter reuses the same handler without starting a listener, running cold-start DDL or starting sweeps. Serverless pool sizes are configurable and SSE is disabled. A real hosted/provider acceptance run is still required; source support is not deployment verification. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for cutover, independent keys, webhook configuration and recovery requirements.

## Source Map

| Directory | Responsibility |
| --- | --- |
| `src/server/` | Runtime composition, HTTP routing, authentication, validation, events and quota boundaries. |
| `src/stages/` | Authorization lifecycle and the financial pipeline. |
| `src/pipeline/` | Execution context, durable replay integration, tracing and bounded concurrency utilities. |
| `src/persistence/` | Schema/invariants, durable stores, agent authority, protected records, audit batches and maintenance workers. |
| `src/crypto/` | Canonical signing, AES-GCM/HMAC record protection and Merkle commitment helpers. |
| `src/risk/` | Trusted features, model training/inference, anomaly assessment and offline drift checks. |
| `src/rail/` | Token interfaces/test implementation and reconnect batch processing. |
| `src/auth/`, `src/domain/` | JWT contracts and typed payment/authorization models. |
| `src/demo/`, `test/` | Isolated synthetic demonstration and regression coverage. |
| `api/`, `.github/workflows/` | Hosted adapter and CI. |

Rail is a modular monolith. Keeping financial state in one transactional database avoids introducing distributed compensation before external provider side effects exist. Microservices, on-chain money and larger neural networks are not prerequisites for correctness.

## Documentation

- [Project status and implementation history](PROJECT_STATUS_REPORT.md): delivered changes, architecture and source details.
- [V2 technical guide](V2_TECHNICAL_GUIDE.md): agent, intelligence and protected-record contracts.
- [Deployment guide](DEPLOYMENT.md): configuration, migration, workers, key retention and operational boundaries.
- [Security review](SECURITY_REVIEW.md): findings, regressions and unpassed release gates.
- [Agent payment security](AGENT_PAYMENT_SECURITY.md): caller boundaries, abuse cases, owner transparency and the staged agent-first roadmap.
- [V1 acceptance record](V1_SIGN_OFF.md): baseline verification and explicit demonstration/production boundaries.

## Remaining Work

The next audit milestone is a minimal contract and an isolated durable publisher with duplicate, ambiguous-response, crash, confirmation and reorganization handling. It is not deployed today. Operator visibility/alerts, legitimate labelled datasets, reviewed risk-policy enforcement, secure mobile offline transport, external funding/refund/reversal lifecycles, provider settlement and hosted recovery acceptance remain unfinished.

Historical accounting issues require reviewed evidence, not inferred opening balances. Database owners can bypass triggers, so least-privilege runtime roles matter. Production key custody/restore, retention, capacity testing and compliance review are not supplied by passing fixtures. There is no claim of zero vulnerabilities, proven fraud accuracy or production readiness.

## License

Licensed under **AGPL-3.0-only**. See [LICENSE](../LICENSE) for the terms. Contributions are welcome; retain the license and applicable attribution when building on this work.

Rail is intended for learning, controlled demonstrations and architectural development. Do not treat its internal receipts or audit proofs as evidence of licensed real-money settlement.
