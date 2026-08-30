# Rail Project Status Report

## Purpose

This document captures the current understanding of the Rail codebase as of the latest review pass. It is intended to serve as:

- a future handoff document
- a project demonstration reference
- a planning baseline for upcoming hardening and scope expansion

The analysis in this report is based on the current source files in `src/`, the root configuration files, the current README, and a validation pass using the TypeScript build.

## How To Use This Page

This page is intended to function as the working wiki for the project.

Use it in the following ways:

- as a high-level project summary for demos and resume walkthroughs
- as a change log of what the project used to be and what it has become
- as a technical map of the source tree
- as a record of current strengths, flaws, and future scope

## Table of Contents

1. Latest Status
2. Project Timeline
3. Project Summary
4. Current Repository Structure
5. Detailed File Structure
6. Build and Runtime State
7. Main Functional Flow Observed
8. Strong Parts of the Current Project
9. Important Flaws and Gaps Identified
10. What the Project Is Today
11. Phase Delivery Record
12. Future Scope

## Latest Status

Phase 1 transaction-safety changes have now been implemented in the codebase.

The major improvements completed in this phase are:

- persisted authorization records were added to the database model
- authorization issuance is now transactional with fund reservation
- payment execution now resolves authorization state from stored records
- authorization usage is claimed inside the payment transaction
- expired authorizations are now eligible for automatic reservation release
- completed same-key retries are now allowed even after an authorization has been consumed

This means the project is no longer relying only on a client-carried signed authorization object for execution safety. The server now has a durable source of truth for authorization lifecycle state.

An important follow-up fix was also applied after live verification: the API boundary now permits legitimate same-idempotency retries for already-completed payments instead of rejecting them early due to the authorization having moved to `used`.

Phase 2 contract-alignment work has now started as well. The first completed Phase 2 improvement is that the sync path has been aligned with stored authorizations instead of accepting bare replay transactions with insufficient execution context.

Security hardening work has also started. The current focus is:

- protecting event visibility without breaking the frontend dashboard flow
- introducing strict route-specific rate limits on sensitive endpoints
- tightening authentication defaults and error behavior

An architecture cleanup pass has also now been completed for the HTTP layer. The original monolithic `src/server/server.ts` has been split into focused modules for:

- configuration loading
- request, response, error, and rate-limit helpers
- authentication and wallet resolution
- validation
- event and SSE handling
- route-family handlers

`server.ts` now acts as the main bootstrap and composition file rather than holding all infrastructure and route logic inline.

## Project Timeline

This report should be treated as a live project book. It records both what the project used to be and what it is now, so the evolution of the system remains easy to explain.

### Pre-Phase 1 Baseline

Before Phase 1, the project already had the broad shape of an offline-capable payment orchestration system, but several critical safeguards were still incomplete.

The project already supported:

- a payment pipeline engine with staged execution
- JWT-based login and API-key-based wallet access
- offline token issuance
- transaction execution with validation and ledger posting
- sync batch processing for queued offline transactions
- PostgreSQL-backed persistence for parts of the system
- an event and outbox visibility path

However, before Phase 1 the important weaknesses were:

- authorization state was effectively client-carried rather than durably tracked server-side
- fund reservation and authorization issuance were not tied together as one atomic persisted lifecycle
- retries could clash with authorization reuse protection
- sync replay was looser than the main execute path
- `src/server/server.ts` had become a very large all-in-one file

In other words, before Phase 1 the project had a strong conceptual architecture, but some of the most important money-safety and consistency guarantees were not fully enforced.

### Phase 1 State

Phase 1 changed the project from a promising payment pipeline into a transaction-safer system.

The Phase 1 improvements introduced:

- persisted authorization records in PostgreSQL
- transactional authorization issuance with reservation
- execution-time authorization lookup from stored state
- authorization claim inside the same payment transaction
- automatic release support for expired unused authorizations
- same-idempotency retry support after successful execution

This phase established a real authorization lifecycle rather than relying only on a signed authorization object returned to the client.

### Phase 2 Progress

Phase 2 began by aligning offline sync replay with the same authorization-backed execution model as the main payment route.

The implemented Phase 2 changes include:

- sync accepts only offline transactions
- each synced transaction must carry `authorizationId`
- device consistency is enforced for sync batches
- sync transactions are prevalidated against stored authorization state before execution

This removed the earlier mismatch where sync could act like a weaker replay path than the main execute flow.

### Security Hardening Progress

The first hardening pass focused on the most visible and most exploitable edges.

The implemented hardening changes include:

- authenticated access to event endpoints
- wallet-scoped event visibility for frontend consumption
- stricter JWT validation behavior
- generic login failure responses
- transactional registration with proper duplicate-user handling
- fail-closed behavior for offline token and sync routes when API key config is missing
- route-specific in-memory rate limiting for sensitive operations

### Current State

The current version of the project is stronger than the pre-Phase 1 baseline in four major ways:

- the authorization lifecycle is now durable and transaction-aware
- retries and replay protection are better aligned
- offline sync follows the same stored-authorization trust model as direct execution
- the HTTP layer is more modular and easier to navigate due to the server refactor

The project is still not the same as a production-deployed fintech system, but it is now far more internally consistent, easier to reason about, and much stronger as a showcase backend project.

## Project Summary

Rail is an offline-capable payment orchestration service. Its core goal is to support payment execution in environments where devices may not always be connected to the internet, while still preserving replay safety, authorization control, and ledger visibility.

At a high level, the system currently aims to do the following:

- issue offline spend tokens while the client is online
- generate short-lived payment authorizations
- reserve sender funds before final execution
- execute payments through a staged pipeline
- support replay-safe execution using idempotency
- persist payment-related state in PostgreSQL
- expose an event stream for operational visibility

The system is not a settlement rail by itself. It is closer to a payment control and orchestration layer that sits in front of or beside actual banking, PSP, or UPI settlement systems.

## Current Repository Structure

The repository is small and focused. The major code areas are:

- `src/server/`
  Main HTTP server bootstrap, route-family handlers, auth helpers, validation, rate limiting, and event wiring.
- `src/stages/`
  Business flow logic for authorization and payment execution.
- `src/pipeline/`
  Generic pipeline infrastructure such as tracing, middleware, retry, idempotency, DLQ, and outbox.
- `src/rail/`
  Offline token issuance and sync batch processing.
- `src/persistence/`
  PostgreSQL migrations and durable store implementations.
- `src/crypto/`
  HMAC signing and HSM integration boundary hooks.
- `src/auth/`
  JWT generation and verification.
- `src/domain/`
  Core domain types.

## Detailed File Structure

This section describes the current TypeScript source layout and the responsibility of each file.

### Root Entry Files

- `src/index.ts`
  Minimal package entry file for the project. It exists as the top-level exported entry point but the main operational HTTP runtime is driven by `src/server/server.ts`.

- `src/demo/runPayment.ts`
  Demo-oriented script for exercising the payment flow outside the HTTP server. This file is useful for local experimentation, although earlier review showed that the demo flow can drift from the live server contract if it is not kept updated.

### Authentication

- `src/auth/jwt.ts`
  Handles JWT generation and verification for login-based user access. This is the main token-issuing and token-validation utility used by the server auth routes.

### Crypto

- `src/crypto/authorizationSigning.ts`
  Defines how payment authorizations are signed and verified. This supports the signed authorization model used between authorization issuance and payment execution.

- `src/crypto/hsm.ts`
  Provides the HSM integration boundary and abstraction hooks. It represents the place where stronger key-management behavior could be integrated later.

- `src/crypto/transactionSigning.ts`
  Handles transaction signature helpers used during payment verification and integrity checks.

### Domain Models

- `src/domain/authorization.ts`
  Defines the authorization domain model and related types. This file captures the shape of the authorization object that moves through the project.

- `src/domain/types.ts`
  Defines core project domain types such as payment transactions and pipeline result structures used across the engine, stages, and server.

### Persistence

- `src/persistence/migrate.ts`
  Contains PostgreSQL schema creation and migration logic. This includes the wallet, ledger, authorization, idempotency, and related persistence setup that the live server depends on.

- `src/persistence/postgresIdempotency.ts`
  Implements PostgreSQL-backed idempotency using database state and advisory locking. This is the durable replay-safety implementation for multi-request execution.

- `src/persistence/postgresOfflineTokenStore.ts`
  Implements PostgreSQL-backed storage for offline spend tokens and token headroom tracking.

- `src/persistence/postgresPool.ts`
  Creates and configures the PostgreSQL connection pool used by the server.

- `src/persistence/postgresWalletStore.ts`
  An older Postgres wallet-store abstraction that has been identified as inconsistent with the live schema and is not the main source of truth for the current server path.

- `src/persistence/walletStore.ts`
  Defines the wallet-store interface abstraction used by wallet-related logic.

### Pipeline Infrastructure

- `src/pipeline/backpressure.ts`
  Contains pipeline backpressure-related support logic for controlling execution pressure and protecting processing flow.

- `src/pipeline/context.ts`
  Defines the execution context object passed through pipeline stages.

- `src/pipeline/dlq.ts`
  Defines the dead-letter queue support used for failed pipeline runs.

- `src/pipeline/engine.ts`
  The core payment pipeline engine. It coordinates idempotency, tracing, pipeline execution, DLQ behavior, and result handling.

- `src/pipeline/errors.ts`
  Contains pipeline-level error definitions and shared error structures for engine and stage failures.

- `src/pipeline/idempotency.ts`
  Defines the in-memory idempotency implementation and the shared idempotency store contract.

- `src/pipeline/middleware.ts`
  Defines middleware support that can wrap pipeline execution behavior.

- `src/pipeline/outbox.ts`
  Defines the in-memory outbox abstraction used to collect pipeline events before they are relayed outward.

- `src/pipeline/parallel.ts`
  Provides helpers for parallelized pipeline work, such as running independent prechecks concurrently.

- `src/pipeline/retry.ts`
  Defines retry-related helpers for pipeline tasks.

- `src/pipeline/saga.ts`
  Contains the saga orchestration abstraction used by the payment execution flow to structure compensatable multi-step work.

- `src/pipeline/stage.ts`
  Defines the stage abstraction and contracts for pipeline stage execution.

- `src/pipeline/tracing.ts`
  Defines tracing helpers used for pipeline visibility and debug logging.

### Rail Offline Flow

- `src/rail/mutex.ts`
  Contains a simple mutex utility used to protect shared mutable state in local or in-memory execution flows.

- `src/rail/offlineTokenStore.ts`
  Defines the in-memory offline token store and the common offline token store interface.

- `src/rail/syncBatch.ts`
  Implements sync-batch processing for replaying queued offline transactions through the main engine.

### Server Layer

- `src/server/server.ts`
  Main HTTP bootstrap and composition file. It wires configuration, persistence, the engine, auth resolution, events, and route-family handlers.

- `src/server/config.ts`
  Loads and normalizes server runtime configuration from environment variables, including rate-limit settings and request limits.

- `src/server/http.ts`
  Shared HTTP-layer helpers including JSON responses, body parsing, error mapping, request errors, and in-memory rate-limiting utilities.

- `src/server/authentication.ts`
  Resolves authenticated wallets from JWTs or API keys and enforces API-key protection for restricted routes.

- `src/server/events.ts`
  Handles server-side event visibility, SSE fanout, outbox event persistence, and relay behavior for frontend-consumable event streams.

- `src/server/types.ts`
  Defines the server-layer interfaces and shared TypeScript types used to compose the HTTP runtime.

- `src/server/validation.ts`
  Holds input validation helpers for transactions, sync payloads, token issuance requests, and other server-facing data structures.

- `src/server/routes/authRoutes.ts`
  Contains registration and login route handling.

- `src/server/routes/paymentRoutes.ts`
  Contains payment authorization, offline token issuance, payment execution, and sync route handling.

- `src/server/routes/eventRoutes.ts`
  Contains the event listing and SSE stream endpoints.

### Business Stages

- `src/stages/authorizationStage.ts`
  Implements authorization creation, authorization lookup, reservation release, and wallet-authorization setup logic.

- `src/stages/paymentPipeline.ts`
  Implements the hardened payment pipeline, validation stage, prechecks, ledger logic, authorization claim behavior, and saga-driven money movement.

## Build and Runtime State

The project currently compiles successfully with:

```bash
npm run build
```

This means the codebase is in a buildable state and not broken at the TypeScript level.

However, build success does not mean all documented flows are fully aligned with the current runtime behavior. During review, several important mismatches were found between the README, the demo flow, and the execution contract enforced by the live server path.

## Main Functional Flow Observed

### 1. Authentication and Identity

The server supports:

- user registration with password hashing using `bcryptjs`
- JWT-based login
- API-key-based wallet binding

The active identity model used during payment operations is:

- either a JWT identifies the user and maps them to a wallet
- or an API key maps directly to a wallet

This identity binding is enforced before payment authorization and execution.

## 2. Authorization Flow

There is a distinct authorization phase before execution.

The authorization flow currently does the following:

- validates the caller identity
- reserves sender funds inside a database transaction
- creates and persists a short-lived authorization object
- signs that authorization using HMAC
- returns the signed authorization to the caller

The authorization object contains:

- `authId`
- `txId`
- sender wallet
- receiver wallet
- amount
- currency
- created time
- expiry time
- signature

This is an important design decision because the execution flow depends on authorization data being present and valid.

### Authorization Storage Model

The system now stores authorizations durably in PostgreSQL.

The authorization record currently includes:

- `auth_id`
- `tx_id`
- sender wallet
- receiver wallet
- amount
- currency
- signature
- `status`
- `created_at`
- `expires_at`
- `used_at`
- `released_at`

The active status lifecycle introduced in Phase 1 is:

- `issued`
- `used`
- `expired`
- `revoked`

At the moment, the implemented operational transitions are:

- `issued` to `used`
- `issued` to `expired`

This is a major safety improvement because the server can now reason about whether an authorization is still executable.

## 3. Payment Execution Flow

The payment execution path is centered around `PaymentPipelineEngine`.

The engine currently handles:

- root tracing
- idempotency deduplication
- pipeline execution
- DLQ insertion on failure
- outbox drain relay simulation

The composed payment pipeline performs three broad phases:

1. core validation
2. parallel prechecks
3. funds and ledger saga

### Core Validation

The validation stage checks:

- amount is positive and safe
- currency format is valid
- sender and receiver are different
- offline channels must include offline token
- offline channels must include device id
- online channel must not carry offline token

### Parallel Prechecks

The system runs two checks in parallel:

- signature verification
- risk scoring

The risk scoring is currently placeholder logic, not production fraud logic.

### Saga Phase

The payment saga performs:

- optional offline token reservation
- authorization claim inside the payment transaction
- sender reservation consumption
- receiver wallet credit
- ledger entry creation
- outbox event append
- offline token finalization
- commit or compensation

The important change here is that authorization claim now happens in the same transaction as reservation consumption and ledger posting. If the transaction rolls back, the authorization does not remain permanently marked as used.

The execute route now also distinguishes between:

- a legitimate retry of a previously completed request with the same `idempotencyKey`
- an invalid attempt to reuse an already-consumed authorization with a different request identity

This preserves anti-replay controls without breaking client retry safety.

This is one of the strongest architectural parts of the system because it expresses payment execution as a controlled, compensatable workflow rather than a single unstructured handler.

## 4. Offline Token Flow

Offline tokens exist in both in-memory and PostgreSQL-backed forms.

Their current responsibilities are:

- issue device-bound spend envelopes
- track spend headroom
- enforce expiry
- bind spend to sender wallet and device
- reduce headroom during execution
- restore headroom on rollback

This is a meaningful foundation for offline spend control.

## 5. Sync Flow

The project includes a sync endpoint intended to replay queued offline transactions once connectivity is restored.

The sync handler:

- accepts a device id
- validates a batch of transactions
- requires each transaction to reference a stored `authorizationId`
- verifies device consistency across the batch
- replays the transactions through the same engine
- rejects online transactions from the sync endpoint

This is a good design direction because it reuses the same idempotent execution path rather than inventing a separate settlement path.

This closes one of the major inconsistencies identified after Phase 1, because replayed offline payments now carry the same stored-authorization reference required by the main execute path.

## 6. Persistence Model

When `DATABASE_URL` is provided, the server enables PostgreSQL persistence and runs migrations on startup.

The migration file currently creates:

- `rail_idempotency`
- `rail_offline_tokens`
- `wallets`
- `ledger_entries`
- `authorizations`
- `authorization_usage`
- `api_keys`
- `users`

The server also creates:

- `outbox`

at startup if it does not already exist.

This means the durable runtime model is clearly centered on PostgreSQL rather than on the in-memory fallback path.

### Authorization Expiry Recovery

Phase 1 introduced automatic expired-authorization recovery.

The server now has a sweep path that:

- finds authorizations still in `issued` state whose expiry has passed
- releases their reserved funds back to the sender wallet
- marks them as `expired`
- records when the release happened

This closes one of the most important failure windows identified during the earlier review.

## 7. Observability and Eventing

The project currently exposes:

- a `/v1/events/stream` SSE endpoint
- a `/v1/events` endpoint for recent outbox events
- pipeline stage events
- ledger-posted events
- system error events

This is useful for demos and operator visibility, and it gives the project a more complete system feel.

That said, the current implementation relies on temporary bridging mechanisms rather than on a clean first-class event delivery abstraction.

The security model for events has now improved:

- event endpoints require authentication
- event visibility is filtered by wallet
- raw `system.error` events are no longer part of the frontend-visible event stream
- browser SSE clients can authenticate using query-based tokens when headers are unavailable

## Strong Parts of the Current Project

Several parts of the codebase are already strong and worth preserving:

### Modular pipeline design

The separation between generic pipeline infrastructure and business stages is clean and extensible.

### Clear offline token abstraction

The `IOfflineTokenStore` contract is well-defined and implemented in both memory and PostgreSQL variants.

### Durable idempotency approach

The PostgreSQL idempotency implementation uses advisory locking and stored execution results. This is a solid baseline for replay protection.

### Authorization-before-execution model

Moving money through a reserve-and-consume pattern is a safer shape than direct debit on request.

### Durable authorization lifecycle

The server now stores authorization lifecycle state instead of relying only on transient signed payloads coming back from clients.

### Ledger writing exists as a real concept

The system does not stop at business approval. It actually records debit and credit entries and emits business events after execution.

## Important Flaws and Gaps Identified

The following issues are currently the most important from a correctness and project-readiness perspective.

### 1. In-memory mode is not truly complete

The README describes a no-Postgres path, but the current server behavior relies heavily on database-backed wallet and identity state.

This means memory mode is currently more of a partial development fallback than a complete supported runtime mode.

### 2. Eventing still needs fuller infrastructure maturity

The event path is stronger than before because it now uses an explicit engine relay callback instead of relying on `console.log` interception and runtime outbox monkey-patching.

However, it is still not a full production-grade event delivery subsystem. It remains a lightweight in-process relay and persistence bridge rather than a dedicated delivery service.

### 3. Some infrastructure is still intentionally lightweight

The codebase is now more internally consistent than before, but some operational pieces are still intentionally lightweight for project scope reasons.

Examples include:

- in-memory rate limiting rather than distributed throttling
- in-process event relay rather than a dedicated broker-backed publisher

### 4. Security hardening is incomplete

Current concerns include:

- rate limiting is still in-memory rather than distributed
- risk scoring is still placeholder logic
- API key provisioning and rotation flows are still minimal even though wallet-bound keys are now resolved via hashed-at-rest lookup

Security improvements now implemented:

- JWTs no longer fall back to a hardcoded dev secret
- duplicate registration handling has been partially improved at the HTTP layer
- login now returns a generic invalid-credentials response
- strict route-specific rate limits have been introduced for login, authorize, execute, sync, and token issue
- wallet-bound API keys are now looked up via hashed-at-rest storage rather than plaintext database comparison
- the event relay path now uses explicit engine-to-event-store forwarding instead of log interception and outbox mutation

### 5. Demo and documentation drift

The demo transaction no longer matches current validation rules, and some developer-oriented docs still overstate the readiness of memory mode and other non-Postgres flows.

## What the Project Is Today

At the moment, Rail should be understood as:

- a serious prototype with real architectural direction
- a partially hardened payment orchestrator
- a PostgreSQL-first backend despite documentation suggesting broader mode support
- a system with a meaningful execution model, but not yet fully consistent across all advertised flows

It is not just a mock pipeline anymore. It already has enough structure to become a robust platform, but it now needs alignment and hardening work more than it needs brand-new feature sprawl.

## Phase Delivery Record

This section is the simplest project-history checkpoint view. It is useful when someone wants to quickly understand what has already been completed without reading the full narrative sections above.

### Pre-Phase 1

Before formal hardening work began, the project already had:

- a payment pipeline engine
- JWT and API-key-based access paths
- offline token issuance
- transaction execution with validation and ledger posting
- sync-batch processing
- partial PostgreSQL-backed persistence
- basic event visibility and outbox concepts

But it still had major consistency and money-safety gaps around authorization state, retries, sync behavior, and server structure.

### Phase 1 Delivered

The following Phase 1 items are now completed:

1. persisted `authorizations` table
2. transactional authorization issuance
3. execution-time lookup of stored authorization state
4. authorization claim tied to successful payment commit
5. expired unused authorization release path

This phase specifically improved money safety and lifecycle consistency around authorization handling.

## What Still Remains After Phase 1

Phase 1 did not finish the entire hardening roadmap. The main remaining items are:

- clean up memory-mode expectations
- harden API key and JWT handling
- replace temporary event forwarding infrastructure
- improve reconciliation, audit, and test coverage

## Phase 2 Delivered So Far

The first Phase 2 contract-alignment improvement is now in place:

1. sync replay now requires `authorizationId`
2. sync replay is restricted to offline transactions
3. sync transactions are prevalidated against stored authorization state before engine execution
4. sync uses the same authorization-readiness rules as the main execute path

## Security Hardening Delivered So Far

The current security hardening slice includes:

1. authenticated and wallet-filtered event endpoints
2. frontend-compatible SSE access using authenticated query credentials when needed
3. strict in-memory rate limiting on the highest-risk routes
4. safer JWT secret handling
5. generic login failure responses
6. offline token and sync routes now fail closed when `RAIL_API_KEY` is not configured
7. hashed-at-rest wallet API key lookup for database-backed API credentials
8. explicit outbox relay wiring instead of temporary console-based forwarding
9. explicit allowed-origin CORS handling instead of wildcard browser access

## Recommended Improvement Roadmap

The improvement roadmap currently recommended is:

### Phase 1: Transaction Safety

- persist authorizations
- make authorization issuance atomic
- validate execution against stored authorization state
- add expiry release and recovery
- redesign execute contract around durable authorization lookup

### Phase 2: Offline Flow Alignment

- redesign sync payloads
- align offline token and authorization model
- fix README and demo
- decide whether memory mode is real or removed

### Phase 3: Security Hardening

- harden JWT configuration
- remove unsafe default secrets in non-dev mode
- reduce public error exposure
- standardize auth rules per endpoint

### Phase 4: Infrastructure Cleanup

- remove or fix stale persistence abstractions
- split `server.ts` into focused modules
- validate configuration at startup

### Phase 5: Operability and Testing

- add reconciliation jobs
- improve auditability
- add integration tests
- add failure-window tests
- strengthen observability

## First Recommended Milestone

The original first implementation milestone has now been completed.

The next recommended milestone should focus on contract alignment:

1. redesign sync payloads to reference stored authorizations
2. update README and demo flow to reflect the new execution contract
3. decide whether memory mode should be made real or removed from the supported story
4. continue security hardening for API keys and JWT configuration

## Conclusion

Rail already has the bones of a compelling system:

- payment authorization
- offline token control
- idempotent execution
- staged processing
- ledger writing
- SSE observability

The next stage of the project should not be random expansion. It should be consolidation:

- make the contracts consistent
- make the money flow durable
- make the security model stricter
- make the infrastructure less temporary

Once those foundations are in place, the project will be in a much better position for demonstration, extension, and production-style hardening.

## Deployment and Runtime Hardening

On 2026-08-30, the first critical-risk hardening category was implemented for deployment and runtime safety.

The server now exposes reusable `createServerContext` and `handleRequest` functions. Local execution still uses `src/server/server.ts` as the operating entrypoint, but importing the module no longer starts an HTTP listener. This makes the same routing system safe to load from the Vercel function at `api/index.ts`.

Hosted serverless execution no longer runs schema migrations or the authorization expiry interval during request-context initialization. Database migrations and outbox schema creation are now available through the explicit `npm run migrate` release command. This makes database initialization a controlled deployment step instead of a competing cold-start operation.

The PostgreSQL pool now supports a configurable maximum and defaults to a smaller pool in serverless mode. SSE is explicitly disabled in serverless mode because instance-local connections cannot provide a durable cross-instance stream; hosted consumers should use the authenticated event polling endpoint until shared event delivery is introduced.

Verification completed for this category:

- TypeScript build passes with `npm run build`.
- The local and Vercel entrypoints share the same request handler.
- Importing the server module no longer automatically calls `bootstrap`.
- Database migration execution is separated from hosted request initialization.

## Money and Transaction Consistency Hardening

On 2026-08-30, the second critical-risk category was implemented for money movement, offline-token accounting, and retry consistency.

Payment idempotency now uses a SHA-256 fingerprint of the complete canonical transaction payload. Reusing an idempotency key with different transaction data is rejected, while failed attempts are not permanently recorded as successful business outcomes and can be retried. This prevents accidental key reuse from returning the wrong payment result and avoids permanently blocking recovery from temporary failures.

PostgreSQL offline-token reservation and finalization now accept the payment transaction client. The hosted payment path performs token headroom changes inside the same database transaction as authorization claim, reserved-funds consumption, receiver credit, ledger writes, and commit. A crash before commit therefore rolls back the complete money state instead of losing token headroom independently.

The payment pipeline can recover a response-loss case by recognizing a complete, matching pair of ledger entries for the transaction before attempting a second authorization claim. Database uniqueness protection was added for one debit and one credit per transaction and for one authorization-usage record per transaction.

Authorization creation is now retry-safe for the same transaction details. A repeated request returns the existing authorization rather than reserving the sender's funds again; a reused transaction ID with different details is rejected. Authorization identifiers now use cryptographically secure UUIDs, and wallet reserve, consume, release, and credit operations verify currency as well as wallet identity.

Verification completed for this category:

- TypeScript build passes with `npm run build`.
- Database migrations complete with `npm run migrate`.
- Memory idempotency behavior was checked for same-key reuse, mismatched fingerprints, and retry after failure.

## Security Hardening Follow-up

On 2026-08-30, the next security category removed credentials from event query strings and made JWT claim validation explicit. Event access now requires request headers, reducing exposure through browser history, access logs, referrer data, and monitoring systems. JWT verification now rejects validly signed tokens whose payload does not contain a non-empty string `userId`.

Production configuration now fails closed when PostgreSQL, the server API key, sufficiently strong JWT/signing secrets, or deployed frontend origins are missing. Local development keeps its documented localhost defaults, while production cannot silently fall back to development origins.

## Ledger and Authorization Integrity Hardening

On 2026-08-30, database-level integrity protections were added for the ledger and authorization state. Wallet balances and reservations must remain non-negative, ledger amounts and authorization amounts must be positive, and an authorization cannot transfer to the same wallet. Ledger entries remain unique per transaction and entry type, while foreign keys connect ledger entries, authorizations, users, API keys, and authorization usage to existing wallets or authorizations.

Reservation release now verifies that the wallet update actually matched a wallet in the expected currency. Ledger writes persist the transaction currency, so multi-currency records do not silently fall back to the database default. A read-only reconciliation utility is available through `findReconciliationIssues` to detect incomplete or unbalanced ledger transactions and invalid wallet reservations without modifying financial state. It also reports orphaned authorization-usage records discovered during migration validation; those legacy records are preserved for explicit review instead of being deleted automatically.

## Application Correctness and Test Foundation

On 2026-08-30, application-level correctness and regression coverage were improved. Unknown routes now return a `404 not_found` response instead of a misleading success response. Ordinary client-facing request errors are no longer duplicated into the system-error event stream, reducing noisy operational records. Outbox relay callbacks are awaited so the request execution path observes relay failures and can rely on idempotent recovery instead of silently discarding asynchronous work.

The repository now includes a built-in Node test command with focused tests for idempotent replay, fingerprint mismatch rejection, retry after temporary failure, amount validation, and offline device-token requirements. These tests are intentionally small and explainable so they can grow alongside the payment guarantees.

## GitHub Integration Testing

On 2026-08-30, GitHub Actions CI was added with a PostgreSQL 16 service container. Every push to `main` and every pull request now runs dependency installation, TypeScript compilation, unit tests, migration checks, shared PostgreSQL rate-limit checks, and durable PostgreSQL idempotency checks. CI uses isolated test keys and database records and does not require project secrets.

The first CI run also identified and corrected a clean-install migration ordering defect: foreign keys are now created only after every referenced table exists. This keeps upgrades safe for existing installations while ensuring a brand-new PostgreSQL database can initialize successfully.

Six additional hardening tests were added for authorization-signature tampering, transaction-HMAC tampering, offline device binding and rollback, trusted proxy identity, configured-origin CORS behavior, and retryable versus terminal failures. The GitHub workflow now executes these together with the existing seven tests.

## Shared Rate-Limit Hardening

On 2026-08-30, durable PostgreSQL-backed rate limiting was added for database-backed deployments. Login, authorization, execution, token issuance, and synchronization now use a database bucket protected by row-level locking, so the quota is shared across warm instances instead of being limited to one process. Memory rate limiting remains available only for local development without PostgreSQL.

## Privileged API Scope Hardening

On 2026-08-30, privileged offline routes were separated by explicit API-key scopes. Offline-token issuance requires `offline_tokens:issue`, while reconnect synchronization requires `sync:write`. The scopes are configured through `RAIL_API_KEY_SCOPES`, documented in the environment example and deployment guide, and denied with `403` when the configured key is not authorized for a route.

## Proxy Identity and Runtime Identifier Hardening

On 2026-08-30, rate-limit client identity handling was made explicit. Forwarded IP headers are used only when the deployment is configured to trust a sanitizing proxy; local direct requests use the socket address, preventing arbitrary clients from choosing their own rate-limit identity. The engine also uses cryptographically secure UUIDs for trace and correlation identifiers instead of `Math.random()`.
