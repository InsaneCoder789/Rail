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

This repository is PostgreSQL-first for serious runs, with limited in-memory fallback support for local development.

The current `main` branch is the polished, resume-grade version of the project: it focuses on transaction safety, explainable architecture, security-conscious design, and a backend structure that reflects how a real fintech execution layer should be modeled.

**Repository:** [github.com/InsaneCoder789/Rail](https://github.com/InsaneCoder789/Rail)



<img width="1752" height="897" alt="image" src="https://github.com/user-attachments/assets/343a760c-a171-4fa7-b06c-35b03984ee89" />



---

## What Rail Does

At a high level, Rail supports the following flow:

1. A user authenticates and is mapped to a wallet.
2. The sender requests a payment authorization.
3. Rail reserves the sender’s funds and persists an authorization record.
4. For offline use cases, Rail can issue a device-bound offline token with limited spend headroom.
5. A payment is executed through a pipeline with validation, prechecks, idempotency, and a ledger-writing saga.
6. If the device was offline, queued transactions can later be replayed through the sync endpoint using the same stored authorization model.
7. The backend emits wallet-visible events for dashboards and operational visibility.

That makes Rail more than a simple transfer API. It behaves like a controlled payment runtime with explicit lifecycle state, replay protection, offline-aware constraints, and ledger-visible execution.

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
  Auth["Auth Routes\nregister / login"]
  Authorize["Authorize Route\nreserve funds + persist authorization"]
  Token["Offline Token Route\nissue device-bound headroom"]
  Execute["Execute Route\nvalidate + idempotent pipeline run"]
  Sync["Sync Route\nreplay queued offline transactions"]
  Events["Event Routes\nrecent events + SSE stream"]

  Engine["PaymentPipelineEngine"]
  Validation["Validation Stage"]
  Prechecks["Parallel Prechecks\nsignature + risk"]
  Saga["Funds and Ledger Saga"]

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
  Engine --> Saga

  Saga --> Wallets
  Saga --> Authorizations
  Saga --> Tokens
  Saga --> Ledger
  Saga --> Outbox
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
- the pipeline runs validation, prechecks, and the funds-and-ledger saga
- the authorization is claimed inside the payment transaction
- the sender reservation is consumed
- the receiver balance is credited
- ledger rows are written
- events are emitted

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
  M --> N["Emit events / outbox"]
```

---

## Main Features

| Area | Current behavior |
|---|---|
| Authentication | User registration, password hashing, JWT login, wallet resolution |
| Authorization | Durable authorization lifecycle with reserve-before-execute behavior |
| Offline tokens | Device-bound spend headroom with expiry and remaining balance tracking |
| Execution pipeline | Validation, parallel prechecks, idempotency, saga, ledger posting |
| Sync replay | Offline-only batch replay with stored `authorizationId` enforcement |
| Idempotency | In-memory for local fallback, PostgreSQL-backed for durable runs |
| Event visibility | Authenticated wallet-scoped events via REST and SSE |
| Rate limiting | Route-specific limits for login, authorize, execute, sync, and token issue |

---

## Project Status

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

### Limited in-memory fallback

If `DATABASE_URL` is not set, Rail falls back to in-memory idempotency and offline-token storage for lightweight development.

That mode is useful for local experimentation, but it is not the main supported runtime story anymore because authentication, wallet identity, and durable execution are fundamentally PostgreSQL-centric in the current codebase.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port. Default `8787`. |
| `DATABASE_URL` | Enables PostgreSQL-backed persistence. |
| `RAIL_API_KEY` | Shared secret for restricted routes such as offline token issue and sync. |
| `KYLR_API_KEY` | Legacy alias if `RAIL_API_KEY` is not set. |
| `JWT_SECRET` | JWT signing and verification secret. |
| `RAIL_SIGNING_SECRET` | HMAC signing secret for transaction and authorization integrity helpers. |
| `RAIL_REQUIRE_TX_SIGNATURE` | If `true`, execution paths require a valid `paymentSignature`. |
| `RAIL_REQUIRE_JSON_CONTENT_TYPE` | If not `false`, JSON routes require `Content-Type: application/json`. |
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
| `RAIL_PKCS11_MODULE_PATH` | Hook for PKCS#11-based HSM integration. |
| `RAIL_KMS_KEY_ID` | Hook for cloud KMS-backed signing integration. |

---

## API Overview

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
- login is rate limited

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

Returns recent wallet-visible events for the authenticated caller.

### `GET /v1/events/stream`

Streams wallet-visible events over SSE.

Frontend note:

- regular clients can use `Authorization: Bearer <token>`
- browser `EventSource` clients can also use `?access_token=<jwt>` or `?api_key=<key>` when custom headers are unavailable

---

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

---

## Selected Source Layout

```text
src/
  auth/
    jwt.ts
  crypto/
    authorizationSigning.ts
    hsm.ts
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
    saga.ts
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
| Run server | `npm run server` |
| Demo script | `npm run demo` |

---

## Current Limitations

This project is much stronger than a toy payment demo, but it is still honest to call out what is not finished yet.

Current limitations include:

- the event relay path still uses temporary bridging mechanics internally
- API keys are still an area that can be hardened further
- in-memory mode is best understood as a local fallback, not a full alternative runtime
- the risk stage is still placeholder logic rather than a real fraud engine
- documentation and demo flows need to be kept aligned as the project evolves

These gaps are tracked more fully in [PROJECT_STATUS_REPORT.md](./PROJECT_STATUS_REPORT.md).

---

## License

Add a `LICENSE` file before publishing the project more widely.

---

## Disclaimer

Rail is infrastructure software for learning, architectural exploration, and controlled backend experimentation. It does not by itself satisfy regulatory, settlement, reconciliation, or compliance requirements for real-money production deployment.
