# Rail Project Status Report

## Purpose

This document captures the current understanding of the Rail codebase as of the latest review pass. It is intended to serve as:

- a future handoff document
- a project demonstration reference
- a planning baseline for upcoming hardening and scope expansion

The analysis in this report is based on the current source files in `src/`, the root configuration files, the current README, and a validation pass using the TypeScript build.

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
  Main HTTP server and route wiring.
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

### 2. Eventing uses temporary patches

The current SSE/outbox flow depends on:

- intercepting `console.log`
- mutating the outbox append function at runtime

This works as a temporary bridge but should not be treated as final infrastructure.

### 3. Some abstractions have drifted from the live schema

`PostgresWalletStore` uses column names that do not match the actual migrated wallet table, suggesting that this abstraction is stale or unused.

### 4. Security hardening is incomplete

Current concerns include:

- JWT secret falls back to a dev default
- API keys appear to be stored in raw form
- client-visible errors may expose too much detail
- risk scoring is still placeholder logic

### 5. Demo and documentation drift

The demo transaction no longer matches current validation rules, and some developer-oriented docs still overstate the readiness of memory mode and other non-Postgres flows.

## What the Project Is Today

At the moment, Rail should be understood as:

- a serious prototype with real architectural direction
- a partially hardened payment orchestrator
- a PostgreSQL-first backend despite documentation suggesting broader mode support
- a system with a meaningful execution model, but not yet fully consistent across all advertised flows

It is not just a mock pipeline anymore. It already has enough structure to become a robust platform, but it now needs alignment and hardening work more than it needs brand-new feature sprawl.

## Phase 1 Delivered

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

- hash API keys
- harden JWT configuration
- remove unsafe default secrets in non-dev mode
- reduce public error exposure
- standardize auth rules per endpoint

### Phase 4: Infrastructure Cleanup

- replace console monkey-patching
- introduce explicit outbox relay interfaces
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
