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

### Portfolio Review And Simulator TTL Correction, 16 October 2026

KYLR compatibility increment: authenticated `/auth/login` now also returns the
wallet ID selected from the verified user's database row, never a client-supplied
wallet field. The token contract is unchanged. A regression verifies wallet binding
and excludes password/hash disclosure. The paired mobile adapter removes its
embedded issuer key, uses this owner identity, persists original attempt and
authorization before execution, and preserves them on retry. This is internal
wallet orchestration, not a UPI-settlement bridge.

The latest logged direct run passed **408 backend tests and all three Chromium
journeys, zero failures/skips**, plus audit zero known advisories and diff check.
Its disposable database was removed. The earlier successful run below predates
the additive login field. No remote CI or Android-to-deployed-Rail acceptance is
claimed by these server results.

Fresh direct verification subsequently succeeded: `npm test`, all three native
Chromium journeys (zero failures/skips) and `npm audit --audit-level=moderate`
(zero known vulnerabilities). The disposable local database was removed. This
includes the three independent agent processes, lost post-commit reply, original
intent replay and changed-payload rejection. The Node host was 20.19.6, not the
CI Node 22/24 matrix; no remote CI or provider settlement claim follows. The earlier
background wrapper failed before tests because it imported CommonJS `pg` incorrectly;
the direct wrapper used `createRequire` and the actual `Pool` export.

Cross-repository maintenance is separately scoped and incomplete; its detailed
tracker stays private instead of mixing other applications into Rail's technical
report. InsaneCoder789 remains untouched. No commits or pushes were made.

Added a short root README with source-grounded architecture, local setup, CI and
documentation links, synthetic-demo instructions and explicit internal-accounting
versus external-settlement limits. It does not advertise fictional customers or
claim unpublished CI acceptance. The profile repository InsaneCoder789 is excluded
from the owner's separately authorized multi-repository maintenance request.

The combined job job-mv9j3h80-ed666c0f finished with 406 backend passes, one failure,
zero skips and confirmed disposable-database removal. Browser/audit stages did not
run because backend acceptance failed. The three-process simulator sent a 3600-second
TTL while the real intent API accepts 60-900 seconds; all proposals were rejected.
The simulator and test now use 300 seconds, with a unit regression assertion.
A fresh integration run is required; no acceptance gate is waived.

### C3 Owner Console Locally Verified, Simulator Acceptance Pending, 15 October 2026

Focused rerun `job-mv9iwopf-0274e6f0` passed the actual console browser journey:
**one passed, zero failed, two unrelated tests excluded by name**. Login, native
passkey enrollment, exact approval without execution, revision-bound limit consent,
internal execution, receipt verification, HTML-injection resistance and session
cleanup passed. Responsive assertions passed at 320/390/768 pixels. Desktop and
mobile screenshots were inspected against the local concept; the table scrolls
within its panel and no page-wide overflow remains. The disposable database was
removed. A subsequent small change also clears hidden totals/fingerprints on logout;
its additional browser assertions await the combined regression run.

The [three-agent simulator](./AGENT_SIMULATORS.md) executable now supports explicit
proposal/status/execution using only its own agent credential and key, a stable
request identity and localhost-only non-production configuration. It imports no
database, owner session or provider adapter. Six simulator unit tests and three
console tests pass. The HTTP/PostgreSQL acceptance case now launches three real
external Node processes, races shared allowance and injects a lost post-commit
reply before inspecting/replaying the original internal transfer. This updated
case is implemented but awaits fresh integration acceptance. No provider-settlement
claim follows from it; C2 remains unfinished and C3 is still in progress.

Historical failure: the first focused console job `job-mv9iv97i-97b054d6` completed real login, native
passkey ceremonies, exact approval, limit changes and receipt inspection, then
failed its mobile horizontal-overflow assertion. It is not an acceptance pass.
Grid/select shrink boundaries are corrected and the browser check now covers
320, 390 and 768 pixel widths. The disposable database was removed; rerun and
visual inspection were subsequently completed by the focused rerun above.

The prior foundation job `job-mv9ic4sc-5c168020` passed **398 backend tests and two
Chromium journeys with zero failures/skips**, dependency audit zero known advisories
and clean diff. The disposable database was removed. Those results cover the C2
contract and C3 agent client, not the later console increment below.

An opt-in backend-hosted [owner console](./OWNER_CONSOLE.md) now uses the existing
real owner/session, passkey, budget and intent APIs. It displays actual owner data,
supports exact approval/rejection, revision-bound limit changes, emergency withdrawal
and verified receipt summaries. It performs no agent execution or fake settlement.
Owner secrets stay in page memory, not browser storage/URLs. Per-response CSP nonces,
same-origin-only requests, text-node rendering, no caching and async session guards
protect the presentation boundary. Production cannot enable the demo flag.

The console browser/visual gate passed in the focused rerun above, while later
simulator and cleanup edits require combined regression. The local design concept
is a reference, not shipped as a static UI. No external provider account/adapter,
durable external worker, commit or push was introduced. C2-C3 remain in progress; the overall goal
is not complete. The owner has confirmed there is no sandbox account yet; real
provider selection/access and sandbox verification remain open. Local work can
continue, but no account creation, paid/live provisioning or simulated-as-real
acceptance is authorized.

### C1 Local Acceptance Passed; C2-C3 Foundations Started, 15 October 2026

The C1 rerun `job-mv9hxvjs-ac64fab6` passed **380 backend tests and both independent
Chromium journeys, zero failures/skips**, followed by a dependency audit with zero
known advisories and a clean diff check. Its disposable database was removed. This
supersedes the earlier combined-browser failure without relaxing any production
quota or deleting negative assertions. C1 is Ready For Review, not committed/pushed
or certified for production. The overall C0-C3 goal remains active.

C2 now has a pure [external payment lifecycle contract](./PROVIDER_PAYMENTS.md):
versioned owner/agent/intent/account/merchant/instrument bindings, fixed fingerprints
and idempotency keys, explicit unknown/required-action states, retained holds, bounded
retry windows and conflict detection. Ten unit tests passed. This is not a provider
adapter, verified callback, durable attempt store or worker. Provider/account selection
remains unanswered, and real sandbox acceptance is explicitly open.

C3's [narrow Node.js agent client](./AGENT_CLIENT.md) now signs actual API requests
with fresh nonces and body-bound proofs, rejects redirects, bounds I/O, keeps credentials
out of public object fields and performs no automatic payment retries. Seven protocol
tests passed. A separate real HTTP/PostgreSQL test with three independently enrolled
agent clients passed shared-budget concurrency, cross-agent denial and internal ledger
checks (the focused command intentionally skipped unrelated cases). No mocked financial
engine was substituted for this case. These eighteen targeted passes are additional
to the earlier 380-test baseline, not a newly claimed 398-test full-suite run.

C2 durable composition/real provider acceptance and C3 scenario scripts, owner demo
and all four end-to-end scenarios remain unfinished. Human/offline behaviour is not
changed by these isolated foundations. No provider secrets, live payments, new external
accounts, commits or pushes were created. Full regression will include these new tests.

### C1 Acceptance Review Corrections, 15 October 2026

The first full C1 job (`job-mv9hqn28-f23882ae`) passed **379 backend tests with no
failures/skips**, then failed its expanded Chromium journey: the combined ceremony
sequence exhausted the unchanged 30-per-five-minute owner-authentication quota.
This is not a browser pass. The original authentication/recovery journey and new
shared-budget journey now use separate disposable browser/database fixtures. No
rate-limit increase, bypass, bucket deletion or removed adversarial assertion is
used to make acceptance pass. The failed job removed its disposable database.

Review also found that strict budget admission checked original creation and
membership consent but not the latest limit-control grant. It now requires all
three. A real-signature regression confirms that a weaker legacy library writer's
unstepped limit revision cannot enable strict proposal/execution authority; exact
owner approval of a new revision restores valid use without rewriting history.
The focused regression passed; the current full/backend and two-browser acceptance
rerun is still required. C1 remains in progress, C2-C3 remain open, and no commit or
push has been made.

### C0 Revalidated; C1 Shared Budgets In Progress, 15 October 2026

C0's isolated acceptance job `job-mv9h0ybe-ead05cc6` completed successfully: **361
backend tests and one native Chromium journey passed, with zero failures/skips**.
The full dependency audit found zero known advisories and `git diff --check` passed.
The disposable local database was removed. This is backend/local evidence, not
remote CI, hosted/provider, physical-authenticator or independent security acceptance.

C1 now adds owner-controlled shared budget envelopes, explicit same-owner membership,
revision-bound limit changes and exact passkey-authorized control records. Existing
mandates can bind to an envelope; shared-budget proposals/intents use v4 fingerprints
while old unbound fingerprints stay unchanged. Conditional database accounting and
deferred totals checks coordinate reservations across agents. Internal execution,
rejection, expiry, withdrawal and owner recovery update shared allowance in the same
transaction as their existing effects. Existing human/offline APIs remain unchanged.

Fourteen dedicated budget tests passed, and three focused real-signature owner/agent
cases passed (the filtered command intentionally skipped unrelated cases). Added
deadline, approval, withdrawal-race and final-commit failure cases passed. A positive
membership-admission case and native browser shared-budget coverage have also been
added. C1 remains in progress pending the full regression/browser rerun and review; the
previous 361-test baseline is not represented as covering these later changes.
The initial migration test caught a non-immutable generated-column expression;
an explicit stored fingerprint with a database payload check corrected it.

See [Shared Spending Budgets](./SHARED_BUDGETS.md) for API, accounting, concurrency
and interview explanations. No external payment provider, settlement, blockchain,
enforced ML, commit or push is introduced by this increment. C2-C3 remain open.

### C0-C3 Delivery Goal Started, 15 October 2026

The owner approved a bounded delivery goal: revalidate the current authentication
baseline (C0), implement shared spending budgets across agents (C1), add one sandbox
provider with durable uncertain-outcome recovery (C2), and deliver a narrow owner demo
with three independent agent simulators and end-to-end failure scenarios (C3).
The existing TypeScript/PostgreSQL architecture and human/offline paths remain.

C0 is in progress. The prior 361 backend passes and one Chromium journey below are
historical evidence, not a fresh run for this goal. Local PostgreSQL connectivity and
the current diff check passed; fresh acceptance will use a disposable local database.
C1-C3 are not implemented by this entry. Provider/account access has been requested;
simulator tests will not be represented as real provider or deployment verification.

The ignored private implementation plan now carries the authoritative milestone,
acceptance and proposed commit checklist. C4-C8 and the original remaining programme
are retained as future scope, not automatically authorized implementation. Stop for
owner review after C3. No commits, pushes, paid provisioning, live payments or work in
the separate frontend repository are authorized by this implementation approval.

### Priority Authentication Goals Completed, 14 October 2026

1. **Owner authentication: passkey step-up, operation-bound challenges and secure recovery: Completed.** Current owner/session-bound WebAuthn grants protect sensitive authority changes. Enrollment, factor removal, recovery-code rotation and lost-key recovery are implemented. Recovery atomically withdraws affected human/offline/agent spending authority, changes the password/session epoch and admits scoped replacement enrollment. Failed ceremonies, stale sessions, substituted operations, recovery concurrency and financial rollback are covered by real-signature PostgreSQL tests and native Chromium acceptance.
2. **Agent authentication: proof-of-possession credentials and key rotation: Completed.** The HTTP layer has one DPoP path, not a bearer fallback. Credentials bind owner-approved public keys; exact origin/method/body, one-use nonces and opaque transactional dispatch prevent substitution/replay. Rotation now requires owner passkey approval over predecessor, new key, unchanged scope and lifetime. Revocation and replacement use one native database timestamp and commit with the grant and audit event. Immutable lineage and owner-visible history support response-loss recovery without storing plaintext tokens. Concurrent rotation, scope escalation, stale admission, audit/final-commit rollback, SQL forgery, original receipt preservation and safe replay are tested.

Fresh acceptance: **361 backend tests passed, zero failures/skips**, plus **one Chromium end-to-end journey passed**, including native owner passkeys, signed agent payment execution, real owner-approved agent rotation, rejection of the old key, unchanged historical receipt/replay, factor lifecycle and owner recovery. `npm test` and `node --test test/ownerPasskeys.browser.mjs` supplied this evidence. GitHub Actions runs these cases when published; remote results have not been claimed. Legacy policy/ledger routing fixtures use an explicit test-only proof-service mock; actual proof security is exercised by the dedicated real-signature/database/browser cases.

The completion audit reproduced a degenerate Ed25519 public-key forgery accepted by the local native verifier. Shared key validation now rejects identity/small-order/non-prime-order/noncanonical keys before agent, owner EdDSA or merchant signature use. Pinned, dependency-free `@noble/ed25519` 3.2.0 supplies point validation; no custom curve mathematics or new authentication service was written. Owner COSE keys are also checked for valid P-256 points or 2048-4096-bit RSA with an odd public exponent of at least 65537. Safe ES256/Ed25519/RSA ceremonies continue to work. Unsafe legacy owner keys cannot assert or consume stored grants. Five additional cases cover these boundaries. Package audit reported zero known advisories, not proof of application-wide invulnerability.

Completion here refers to the original Goals 1 and 2 backend implementation and local acceptance, not production certification. Prior entries held these goals open for deployment/custody/device gates; those gates remain explicitly within **Goal 12: Production acceptance**, alongside hosted/proxy interoperability, least-privilege roles, recovery/restore, monitoring and independent review. No scope is removed from the full twelve-goal plan. Goals 3-12 remain unfinished. There is no new blockchain, ML service, queue system or authentication provider in this priority change. Issuance and rotation share a small credential writer in the existing module; obsolete bearer routing was deleted. No commit or push was performed.

### Task 2 Proof-Enabled HTTP And Financial Dispatch, 14 October 2026

The actual server context now requires enrolled public keys for agent credentials and DPoP authentication for agent use. Canonical `RAIL_AGENT_API_ORIGIN` binds signatures independently of Host/forwarded headers; malformed values fail startup and missing configuration disables proof routes instead of downgrading. A bounded raw-byte reader preserves exact signed bodies, rejects invalid UTF-8 JSON and keeps existing size/time limits. Nonce bootstrap, identity, proposal/history and execution routes enforce shared source/agent quotas and exact query-free targets; CORS permits the DPoP header.

Authenticated requests yield opaque, non-serializable server capabilities. Transactional dispatch matches credential/key, method/path and entry-snapshotted body, claims dispatch once, and rechecks live authority/freshness before final financial commit. Copied metadata, wrong route/body, duplicate dispatch and revoked credentials are denied. Proof admission and money idempotency remain separate: a fresh proof can return the original completed result without new ledger entries. Compatibility fixtures are not production bearer writers; deployed legacy agent credentials require replacement rather than upgrading old consent/receipts.

Five new configuration/HTTP/dispatch cases passed, including deferred commit rollback and signed atomic execution/replay. The native Chromium journey also passed with actual signed agent HTTP calls. Atomic owner-approved rotation, its concurrency/response-loss/history acceptance and production interoperability remain open. No numbered task is marked Completed; the full twelve-task goal remains intact. No commit/push or real API origin/key was changed.
### Task 2 Key Enrollment And Durable Admission, 14 October 2026

Optional Ed25519 public-key credentials now require owner passkey approval of exact agent/key/scope/TTL, including proposal-only credentials. Immutable SQL key/thumbprint and consumed-grant checks preserve v1 unbound history and use a v2 digest for enrolled keys. Protected authority receipt reconstruction recognizes these new issuance grants. Enrolled credentials are deliberately unavailable through old bearer routes until proof-enabled routing exists; readiness does not claim usable execution or silently downgrade them.

The PostgreSQL proof store provides hashed credential/key-bound 60-second server nonces, owner-first live-state locks, raw-byte snapshots, database-time verification, atomic one-use nonce/proof-ID claims and bounded outstanding/retained capacity. Seven new database cases cover exact key substitution, immutable binding/migration, concurrent capacity and admission, secret hygiene, invalid signature/body non-consumption, credential isolation, duplicate proof IDs, final-commit rollback and revocation/recovery denial. Full local verification passed 342 tests without failures/skips. HTTP trusted-origin/raw-body integration, mandatory-key cutover, dispatch admission binding, rotation and full route acceptance remain open. All twelve tasks retain their original scope; no numbered task is Completed and no commit/push occurred.

### Task 2 Cryptographic Foundation, 14 October 2026

Added a bounded Ed25519 DPoP verifier with public-only JWK parsing, stable key thumbprints, exact token/method/URL/server-nonce binding, 30-second freshness and a mandatory digest of raw body bytes. Six new tests use real signatures and reject substitutions, malformed/private/wrong-algorithm keys and altered payloads. The complete suite now passes 335 tests, zero failures/skips. The verifier does not consume nonces and is not yet wired to HTTP: existing agent credentials remain bearer tokens. Owner-authorized enrollment, PostgreSQL replay admission, fail-closed route enforcement, rotation and their integration tests are still required. See [Agent Proof Of Possession](AGENT_PROOF_OF_POSSESSION.md). No task completion, deployment, commit or push is claimed.

### Task 1 Browser Acceptance And Wallet Recovery, 14 October 2026

Fresh verification passed 329 backend tests with zero failures or skips, followed by one Chromium journey through the actual HTTP runtime and isolated PostgreSQL storage. Native browser WebAuthn calls exercise enrollment, exact payment approval/execution/replay, additional-key enrollment, key removal, recovery and replacement enrollment. Adversarial checks reject used challenges, changed payment terms, password-only recovery enrollment, stale sessions/agent credentials, pending-recovery spending and the wrong relying-party hostname. GitHub Actions now installs Chromium and runs this journey on each Node matrix entry; remote execution remains unverified until publication.

Recovery now withdraws ordinary issued authorizations, releasing their reservations, and permanently revokes wallet API keys and offline tokens in the same transaction as agent withdrawal and the password/session reset. Pending recovery blocks financial access. Money work revalidates the ingress JWT epoch or wallet-key status inside its transaction, preventing a request authenticated before recovery from spending after replacement enrollment. Existing committed ledger entries and receipts are not reversed or rewritten. Two additional PostgreSQL cases cover these boundaries.

Task 1 remains in progress against its documented operational acceptance gates: deployed legacy cutover, reviewed key custody/restore and configuration-specific acceptance are not proved by local tests. Chromium uses a virtual authenticator, not a physical-device attestation claim. Lifecycle outbox events do not imply delivered email/push notifications. Tasks 2-12 retain their full scope. No commit, push, real secret change or hosted deployment occurred.

### Task 1 In Progress: Recovery And Factor Lifecycle, 13 October 2026

Implemented ten high-entropy offline recovery codes returned only after first/recovery enrollment or passkey-authorized rotation. Stored hashes are domain-separated by owner; unused prior codes are revoked on rotation. Exact-credential removal requires step-up and cannot remove the last active key. Pending additional enrollment now retains/rechecks its original authorizing factor, closing a discovered revocation gap. Key history is retained rather than deleted to reopen password-only bootstrap.

Recovery requires a current owner JWT, current password, unused code and different replacement password. One transaction consumes the code, replaces password/session epoch, revokes factors and all owned agent identities/credentials/mandates, releases pending policy holds and records the event. Committed money/spent budget/receipts and other owners are untouched. A hashed ten-minute capability binds the newly returned JWT session, owner, epoch and RP/origin and authorizes only new-key enrollment. Completion, key insertion, code rotation and event commit together. Duplicate old credential IDs, expiry, audit failure, deferred commit failure and real backend disconnect cannot partially complete recovery. Lost responses can restart using another remaining code and replacement password while enrollment is pending; completion invalidates that old set. There is no password-only/support/email reset shortcut.

Additive recovery/code/challenge/credential links are immutable, and consumed codes bind one-to-one to recovery records. One authentication owner per wallet is now a database invariant; duplicated legacy ownership must be audited before migration. Original security evidence stays verifiable. Source/owner ceremony quotas are 60/30 per five minutes, enough for the multi-call lifecycle; recovery separately allows only five attempts per owner per fifteen minutes, and challenge/financial quotas remain. Active/retained-key caps are 10/100; recovery-code history is capped at 10,000 rows, with archival still a Task 8 gate.

Fourteen new cases bring full local verification to 327 passes, zero failures/skips, including PostgreSQL and real software-authenticator signatures. Cases cover secret/hash hygiene, rotations/replay, full authority withdrawal and isolation, scoped enrollment, concurrency, response loss, audit/deferred/crash rollback, duplicate credentials, factor revocation, immutable history, unique ownership and shared HTTP quotas. Pinned development-only Playwright 1.64.0 is being prepared for actual browser acceptance; it is not yet a passed browser gate. Reports/CI/private scopes are updated. No commit/push, real secrets/origins, real recovery credentials or hosted deployment were changed. Outbox lifecycle events are implemented, not actual email/push delivery. Task 1 remains in progress pending browser and operational acceptance; Tasks 2-12 retain their original scope and no numbered task is marked Completed.

### Task 1 In Progress: Mandatory Agent Authority Step-Up, 13 October 2026

The HTTP runtime now requires real same-session passkey grants for execution credential issuance, spending mandate creation and exact agent approval. Fixed-order exported digest helpers normalize scope/TTL, policy and receiver order, or exact agent/intent/fingerprint. Consumers ignore body-supplied verification claims and consume grants through the same client as the protected changes, owner evidence and events. Injected audit/final-transaction failure restores grant consumption and removes attempted consent/encryption state. Emergency revocation remains grant-free; ordinary human/offline payment contracts are unchanged.

Encrypted original consent/approval records retain verified passkey context, and execution receipts also bind credential issuance step-up. Verification checks protected snapshots against consumed grant metadata and exact operation fingerprints. SQL enforces immutable/unique grant links, owner/purpose/timing bindings, credential TTL/scope fingerprints and approved-intent linkage. Code-level legacy cutover rejects old JWT-only mandates, unstepped intents and execution credentials for fresh strict-runtime spending without fabricating upgraded history. Readiness hints reflect nullable legacy markers; fresh execution credentials can retrieve historical committed outcomes while original receipts remain unchanged. Direct production library writers must adopt the same required boundary; compatibility fixtures are not a production bypass.

New JWTs use random identifiers so same-second logins have distinct session bindings. Eight additional tests bring full local verification to 313 passes, zero failures/skips, including PostgreSQL and actual passkey signatures. New cases cover complete financial execution/receipt provenance, changed terms/session, audit rollback, legacy rejection/replay, missing services/body forgery, SQL grant reuse/TTL, HTTP JWT-only denial and distinct sessions. Schema-isolated tests caught extension-dependent hash lookup; native PostgreSQL hashing fixes the search-path dependency. CI includes this test file; remote/browser/hosted acceptance is unverified. Reports and private scopes are current; no commit or push occurred.

Task 1 remains incomplete: secure lost-key recovery, credential removal/recovery-code lifecycle and actual browser/cutover acceptance are next. Tasks 2-12 retain their full scope; no numbered task is marked Completed.

### Task 1 In Progress: Owner Passkey Ceremonies, 13 October 2026

Added pinned SimpleWebAuthn 14.0.3 registration/assertion verification, owner-JWT-only ceremony/list routes and PostgreSQL-backed challenge/passkey/grant storage. First enrollment rechecks the password; later enrollment consumes an existing-passkey grant. Original credential history prevents password-only re-enrollment after revocation. Requests bind the exact bearer-session fingerprint and current user/wallet/credential version. Actual UV, origin/RP, counter and signature checks run; cross-origin frames are rejected. Challenges are one-use even on failed verification, with shared per-user capacity and source/owner quotas.

Two-minute grants retain hashed random tokens and exact operation/digest bindings. Supplied-client consumption requires an open transaction, allowing the protected operation to roll back grant consumption. SQL guards preserve identity, challenge/grant binding and counter/revocation history. One database clock sample fixes a lifetime CHECK race found by the real-database tests. Independent authority receipts and current financial flows remain compatible.

Task 1 is not completed: this slice does not yet enforce passkeys on spending-authority changes or supply recovery/removal/rotation/cutover. Operation digests for future actions do not grant payment authority. [OWNER_PASSKEYS.md](./OWNER_PASSKEYS.md) documents contracts and outstanding acceptance. Tasks 2-12 remain open as listed below; no task is marked Completed. CI explicitly exercises real software-authenticator fixtures, not mocked verifier success. Actual browser/device/hosted acceptance is still required. This work is uncommitted/unpushed; prior milestone `48c1c15` remains published.

Full local verification: 305 passes, zero failures/skips, including PostgreSQL. Fifteen new cases cover configuration/startup, cryptographic ceremonies, exact-operation/session/owner binding, outer rollback/autocommit refusal, enrollment races/password checks, origin/frame/UV tampering, counter/challenge replay, revocation/stale sessions, shared capacity, expiry, SQL mutation guards and authenticated HTTP quotas/no-store. Production dependency audit reports zero known advisories, not proof of zero application vulnerabilities. No real environment setting, passkey, recovery credential or hosted deployment was provisioned.

### Authority And Checkout Milestone: 13 October 2026

This release groups protected original consent/decisions and execution receipts, exact internal-wallet checkout binding, configured merchant signature verification, SQL invariants, deployment guidance and regression/CI coverage into one milestone. Earlier entries saying uncommitted/unpushed describe the state when each slice was completed; Git history records publication of the grouped release. Unrelated local manuals/deliverables and ignored private planning documents are outside this release. The verified local baseline is 290 passing tests with no failures/skips; remote CI, hosted deployment and real merchant/provider acceptance are separate gates, not implied by a repository push.

Remaining work, in delivery order:

1. Stronger owner step-up for sensitive grants/approvals, with safe passkey enrollment, one-use operation-bound challenges and recovery.
2. Agent proof-of-possession authentication and reviewed key enrollment/rotation, without giving agents owner or operator credentials.
3. Merchant onboarding, ownership checks, trust-key lifecycle/recovery and explicit mandatory-quote policy beyond currently configured recipients.
4. Durable fair admission before financial locks, with per-owner/agent bounds, leased claims/fencing and measured starvation/isolation tests.
5. Versioned audit leaves that include owner/agent authority and merchant evidence while preserving old proofs.
6. An isolated testnet audit publisher, independent checkpoints/proof verification, signing limits and finality/reorganization recovery. No on-chain funds.
7. Owner control panel and narrow agent SDK: exact approvals, consent modes, held/spent allowance, revocation, truthful receipt/publication states and safe timeout retries.
8. Paginated histories and explicit archival/retention, capacity and privacy policies that preserve required financial/replay evidence.
9. One authorized provider sandbox with opaque owner-enrolled instruments, durable unknown outcomes, verified callbacks and settlement reconciliation.
10. Refund/reversal/cancellation and dispute lifecycles backed by guarded accounting; never retry an unknown external payment as a new transfer.
11. Trusted risk labels, calibration/drift/latency acceptance and bounded agent-abuse telemetry before any reviewed risk enforcement. Current models remain shadow-only; larger models need measured benefit.
12. Hosted fault/load acceptance, least-privilege runtime/migration/worker roles, key custody/restore testing, monitoring/runbooks and standards interoperability/conformance. Independent security and compliance review is required before real-money release.

### Configured Merchant Quote Signatures: 13 October 2026

Added `src/crypto/merchantQuotes.ts` for bounded operator-enrolled recipient-bound Ed25519 public keys, canonical quote bytes, strict signature proof parsing and snapshot verification. Merchant private keys stay outside Rail and agent clients; no key, merchant or network integration was provisioned. Malformed trust configuration fails before connecting. Quotes bind every checkout field, fee-inclusive total, expiry, owner funding audience and signing key ID. Agents supply only a key ID/signature, not their own trusted public key or verification flag.

Configured recipients require signed checkouts at proposal, approval and fresh execution, including older unsigned intents after enrollment. Revoked keys deny fresh work while retaining mandatory-proof policy for their recipient. Deleting all recipient entries removes that policy and is explicitly not safe revocation. v3 fingerprints bind attestation metadata/signature; absent proofs preserve v1/v2 fingerprints and old evidence. Immutable nullable storage and a unique recipient/quote-ID index prevent multiple retained signed intents across agents and versions. Advisory locking makes concurrent conflicts explicit; same-request retries retain the original intent. Rejection/expiry requires a new quote ID; financial failure retries the existing intent.

Protected owner decisions and execution receipts retain public-key/signature/fingerprint snapshots. Historical reads verify signature consistency and protected authority, not current trust; completed replay remains stable after key revocation. New execution checks current trust first. Human/offline paths remain unchanged. Twelve added cases cover field/audience/key tampering, malformed/private/wrong-algorithm registry keys, revoked/replaced keys, bounded proof parsing, HTTP provenance, unsigned downgrade, concurrent single-use, stale unsigned authority, migration/immutability, rollback/retry and fail-closed startup. Full local suite: 290 passes, zero failures/skips, including PostgreSQL. CI explicitly runs the merchant test file; remote results and hosted acceptance remain unverified. Reports/scopes were updated; no commit/push occurred.

This is `configured_merchant_signature` assurance, not merchant KYC/reputation, fair pricing, original invoice truth, delivery or settlement. Operator enrollment/recovery, consistent multi-instance trust configuration, mandatory quote policy for unregistered recipients, stronger owner step-up and authority-inclusive audit roots remain open. Operational metadata is relational plaintext, and SQL checks do not verify signatures or stop a database owner bypassing controls.

### Internal-Wallet Checkout Binding: 12 October 2026

Agent proposals now accept an optional bounded `checkout` descriptor: merchant wallet, quote ID/version, subtotal, fees, total, currency, canonical UTC expiry and internal funding wallet. The merchant must equal the receiver, the funding wallet must equal the credential's owner, and the total must equal the transfer amount. Policy and balance checks therefore cover fees too. The whole total goes to the receiver; there is no separate provider-fee distribution.

Descriptors are copied/frozen before asynchronous work. Versioned canonical tuples bind all checkout fields into proposal/intent fingerprints; absent checkout preserves existing v1 fingerprints and receipt bodies. Quote changes require a new request/approval. Additive nullable JSONB storage preserves historical data; database checks reject malformed/mismatched bindings and immutable-history guards reject checkout edits. Database time clips the intent to the earliest quote, mandate or request deadline. An expired proposal leaves no reservation, and expiry during execution rolls back the financial transaction. A completed replay remains the original outcome after quote expiry, subject to existing live authority checks.

Exact-mode owner decisions and execution receipts include the checkout and `agent_proposed_unverified` assurance. This binds what was requested, not a merchant signature, verified invoice, fair price or enrolled provider instrument. No card/PAN, arbitrary prompt or caller-supplied verification claim is accepted in the descriptor. Merchant-authenticated quotes, owner step-up, fair admission and provider integration remain separate work. Seven regression cases exercise parsing, caller mutation, retry binding, fee/funding policy, expiry, SQL guards, protected receipts, repeated migration and rollback. Full local suite: 278 passes, zero failures/skips, including PostgreSQL. This increment remains uncommitted and unpushed; remote CI and deployment were not run.

### Original Owner Consent And Decisions: 12 October 2026

Extended the uncommitted authority milestone with immutable encrypted records captured when a new mandate is created or an effective approve/reject decision occurs. Separate mandate/approval/rejection domains bind policy, exact request, database time and owner authentication context. HTTP context comes from the verified owner JWT, not request JSON; user/wallet/credential version is rechecked under a shared lock before recording. No JWT is retained. Internal callers are labelled `trusted_library`, not silently presented as authenticated humans. Stale JWT context returns 401 with rollback.

Execution and approval retry verify original consent and required approval; the execution receipt commits their hashes and owner explanations disclose authenticated provenance. Duplicate approvals preserve first ciphertext/time/context. Rejection keeps previous approval history while preventing execution. Budgeted payments use original advance consent without inventing per-payment acknowledgement. Fresh proposals verify consent before holding allowance. Session logout invalidates sessions but does not rewrite evidence or automatically revoke persistent grants; explicit agent/mandate revocation withdraws them.

New marker/constraint checks require mandate consent and exact-mode decisions, with immutable history. A common authority nonce registry and committed-record quota now cover consent/decisions/execution; failed writes roll back their increments. Old markers and ciphertext are preserved without fake backfills. Older mandates need fresh consent for new proposals; readiness flags reflect legacy markers. Emergency revocation remains possible without keys and releases unexecuted holds.

Added nine cases covering authenticated HTTP provenance versus body forgery, stable concurrent decisions/rejection history, truthful budget consent, missing writers, stale/mismatched actor context, corrupted approval, cross-purpose substitution, legacy mandate denial and keyless emergency revocation. Full local suite: 271 passes, zero failures/skips, including PostgreSQL. Clean-install testing exposed and fixed a constraint-name collision and a trigger row-shape evaluation defect. Existing human/offline, accounting, replay, key rotation and authenticated read tests remain passing. Docs/CI/private reports stay current. No user-signature/passkey assertion, authority-inclusive audit root, fair scheduler, sandbox or provider connector is claimed. No commit, push or hosted/remote acceptance occurred.

### First Terminal Build Slice: Protected Execution Authority, 12 October 2026

Implemented a narrow first receipt slice in `src/persistence/agentEvidence.ts`: independently keyed, purpose-bound AES-256-GCM/HMAC snapshots of immutable mandate policy, consent mode, exact intent/payment fingerprints, executing credential, receiver/amount and execution time. Assurance is explicitly `server_observed_authority`, not an independently signed owner decision or proof of human presence. Separate original consent/approval provenance and complete terminal merchant/quote contracts remain next dependencies.

Agent execution writes required evidence through the same outer client as authorization, wallets, ledger, risk/payment evidence, allowance consumption, replay and events. Deferred guards reject missing/mismatched records; ordinary receipt/history mutation is blocked. Quota/write/final-commit failure rolls back execution. Replay verifies and retains original ciphertext without another encryption/debit. Fixed field-order commitment encoding addresses JSONB key reordering. Shared bounded envelope primitives retain risk-v1 compatibility while rejecting authority/risk purpose substitution.

Owner-JWT-only `GET /v2/agents/:agentId/intents/:intentId/authority` returns sanitized verified policy details or `not_executed`, `legacy_unavailable`/`verification_unavailable`; no tokens/keys are disclosed and responses use `no-store`. Reads reject cross-owner/agent bindings. Owners can inspect history after revocation while agent execution still requires live authority.

`RAIL_AGENT_AUTHORITY_KEY_RING` enables agent spending with material independent of configured/retained payment/risk keys. Missing configuration disables agent spending/execution-credential issuance, not human HTTP startup. Bad/reused configured material fails before pool creation. Actual secrets were not changed. Migration preserves historical nullable markers; new intents require receipt version 1. Old unexecuted requests need hold release, a new request ID and applicable approval, not fabricated evidence. Mixed old/new writers cannot safely execute new protected intents.

Added 13 cases for both modes, concurrent original replay, purpose/tamper rejection, keys/startup, owner-only HTTP reads, missing/write-failed receipts, rotation/loss, quota rollback, administrator-corrupted storage and legacy cutover. Full local verification: 262 tests pass, zero failures/skips, including PostgreSQL. CI explicitly includes receipt tests. Authority snapshots are not in v1 Merkle leaves; no chain publisher, fair distributed queue, runtime sandbox, passkey integration or provider connector was added. Human/offline regressions remain passing. Changes stay uncommitted; no push or remote CI/deployment acceptance occurred.

### Transaction Isolation And Fair Admission Planning: 12 October 2026

Extended the private terminal scheme to retain human-payment safeguards and require transaction-scoped agent access, immutable authorized request bindings and server-owned scheduling. Source review confirms fresh payment contexts/outboxes and atomic database composition; existing stage semaphores are process-local, not a distributed fair admission system. Planned work includes owner/agent admission bounds before financial locks, coordinated claims and stale-worker fencing, revocation/expiry rechecks, alternate-route parity and cross-agent/flood/crash regression tests.

Explicit limits: Rail accepts agent requests as data rather than running agent code; logical request isolation is not an OS sandbox. Agents must have no terminal messaging or other-agent control capability, but external collusion and shared wallet/database contention cannot be declared impossible. ACID covers internal PostgreSQL effects, not provider/chain side effects. No new runtime queue, sandbox, RLS, isolation level, dependency, test run, commit or push was added in this planning increment.

### Agent Transaction Terminal Direction: 12 October 2026

Extended the private implementation scheme from delegated wallet transfers toward a complete agent-facing payment authorization workflow. The proposed terminal authenticates the caller, resolves trusted merchant/quote/funding-source bindings, enforces owner consent, executes through the existing internal engine or a future separate provider adapter, and exposes distinct authority/execution/evidence statuses. Preserve human and offline contracts. External calls cannot share PostgreSQL atomicity; sandbox adapters require durable uncertain-outcome handling and reconciliation before any real-payment claims.

Reviewed official AP2, Visa Intelligent Commerce and Mastercard Agent Pay material: agent payments are an existing category, so Rail's positioning must emphasize its implementation and standards-aware integration rather than claim to invent the category. No interoperability certification or provider connector is implemented. Planning now prioritizes a controlled internal-wallet terminal with versioned authority receipts, then owner/agent trust, independent transparency and separately verified provider expansion. No runtime code/dependencies, commit or push changed in this planning revision.

### Agent-First Implementation Planning: 12 October 2026

Reviewed current agent authority, owner authentication, financial execution, protected evidence, audit batching and runtime composition contracts for the new direction. Prepared a private implementation scheme distinguishing existing features from planned authority receipts, stronger owner authentication, versioned independent anchoring, owner-facing integration, validated risk assistance and operational acceptance. Human and offline payment foundations remain in scope. Current audit leaves still bind payment/risk only; no new consent-proof capability is claimed.

The next implementation slice is versioned protected mandate/decision/execution provenance with owner-only explanations and explicit legacy/cutover tests. No runtime code, dependencies, API behavior, commit or push changed in this planning increment. The latest implemented-backend baseline remains the previously verified 249 tests, not a new planning test run. Detailed forward scope remains private under the existing ignore rule; implementation waits for the owner's next instruction.

### Approach-First README and Milestone Commits: 12 October 2026

Reordered the README narrative around the owner's approach: delegate payment tasks to AI agents without delegating unrestricted financial authority. The opening now explains owner-defined boundaries, both consent modes, a concrete invoice-assistant example, restriction/retry defenses and owner visibility before implementation details. Human payments and offline orchestration remain explicit. Agent controls lead the implementation table; package metadata and the agent security guide use the same positioning.

Corrected the next-work ordering: protected mandate/decision authority receipts must precede claims of blockchain-verifiable consent; then add independent anchoring and owner-facing integrations. Current roots remain local/unanchored, ML remains shadow-only and external settlement/production acceptance remain unfinished. This adjustment adds no runtime feature and changes no financial or API contracts.

At the owner's request, automatic category-by-category commits stop. Accumulate reviewed, related work into coherent milestone-sized changes and commit only when explicitly requested. Do not rewrite, squash or amend existing history merely to reduce the count. The prior authority-hardening commit remains local and unpushed; this documentation/metadata increment is left uncommitted. Preserve descriptive commit messages when a commit is requested.

Verification: reran `npm test`; all 249 tests pass with zero failures/skips, including live PostgreSQL. README relative targets, balanced code fences, package JSON and `git diff --check` pass. Existing Mermaid diagrams are unchanged. Private reports remain ignored. No commit, push or remote CI run was performed for this increment.

### Agent-First Direction and Immutable Authority: 12 October 2026

At the owner's request, Rail now leads with owner-controlled AI-agent transaction execution while preserving human payments and its offline-aware foundation. PostgreSQL still enforces money and policy; ML remains shadow-only and audit roots remain unanchored.

Fixed an ordinary-SQL authority mutation gap. `src/persistence/migrate.ts` now installs update/delete guards on `rail_agents`, `rail_agent_credentials` and `rail_agent_mandates`. Owner/agent identity, credential hash/scope/lifetime, and mandate mode/currency/recipients/limits/lifetime cannot be rewritten. Revocation timestamps cannot be cleared or changed, and revoked agents cannot be revived. Permission changes require a new owner-created record. Budget counters remain governed by existing deferred intent/payment consistency checks; repeat revocation and atomic execution still work. Repeated migrations preserve controls.

Five new regression cases cover identity reassignment, credential promotion/replacement, policy relaxation, revocation reversal and deleted history. Expiry tests now seed deadlines at insertion and let database time elapse rather than rewriting authority history. Expiry after financial work still rolls back the payment; lazy cleanup releases expired holds.

Added `docs/AGENT_PAYMENT_SECURITY.md`: caller boundaries, both acknowledgement modes, abuse cases, owner-visible data and staged receipt/chain/UI/production work. README reflects agent-first positioning. No blockchain publisher, SDK, owner step-up or protected policy receipt is claimed as delivered. Current payment/risk leaves do not prove full policy consent. Agents must never receive owner JWTs, privileged service keys, database access or server keys. Database owners can disable guards; compromised trusted writers can forge inserts.

Verification: 249 full-suite tests pass, zero failures/skips, including live PostgreSQL; 43 explicit agent tests pass. Existing GitHub Actions runs both on Node 22/24 and PostgreSQL 16. Remote CI and deployment were not run for this increment. Unrelated working-tree files were preserved.

### README and Repository Banner Refresh: 12 October 2026

Rebuilt `docs/README.md` around the current payment control/execution backend rather than the earlier transfer-only overview. It preserves offline-aware scope while explaining available/reserved accounting, exact authorization, atomic execution/replay, owner-controlled agents, encrypted evidence/risk, optional shadow intelligence, durable local Merkle batches and event delivery. Three Mermaid flows cover execution, agent authority and audit batching, with future chain publication visually separated. Removed the stale statement that durable audit storage is not implemented; the contract/publisher/finality and production gates remain explicitly unfinished.

Setup now uses the actual `.env_example` name, locked installation, PostgreSQL 16 development container and CI-covered Node 22/24 versions. Required independent key rings, placeholder replacement, zero-funded registration, safe isolated demo boundaries, integration-test database requirements, privileged-service quotas and maintenance scheduling are documented. API/source/script maps and AGPL license links are current. The earlier [architecture banner](https://github.com/user-attachments/assets/343a760c-a171-4fa7-b06c-35b03984ee89) remains a historical reference, not current runtime documentation.

Added the repository-local `docs/assets/rail-banner-v2.png`, a 1983 x 793 brand banner generated with the built-in image tool. Its full design prompt is retained in `docs/assets/rail-banner-v2.prompt.txt`. The visual says "Payments with permission" and depicts controlled coordination, not a deployed blockchain or settlement connector. No runtime code, existing secrets, environment example, private-roadmap publication or unrelated manuals changed. Private reports were updated locally and remain ignored.

Verification: 244 backend tests pass, zero failures/skips, including PostgreSQL. All 18 detected link/image references were checked for applicable relative targets; npm script references and balanced code fences pass. All three Mermaid diagrams parse successfully with Mermaid 11.12.0, and final diff checks pass. Preview-only Mermaid tooling is isolated outside the repository, with no project dependency/lockfile change. The banner was visually inspected. This documentation change is not a production acceptance result or a remotely verified GitHub render.

### Independent Source and Identity Quotas: 12 October 2026

Closed SEC-35's route-level quota bypass. Authorization, execution, protected risk/evidence reads, event reads/streams and agent routes now apply independent source and server-resolved identity allowances. Source limits run before authentication and body parsing; identity limits run before payload validation or expensive work. Malformed and invalid-credential attempts count rather than evading the limiter. Registration has only source authority before enrollment; login retains its independent hashed-account allowance. Logout-all now has source and signed-user allowances. Agent management adds missing pre-authentication source protection.

Token issuance and synchronization use a stable `configured_service` allowance after their existing privileged key/scope check. This runtime has one configured issuer: changing body wallet/device IDs, IPs or that key does not create another issuer allowance. This is not multi-tenant scoped-key ownership. Original financial limits/windows, device binding, exact approvals, atomic money and replay semantics are retained; stricter ordering may return authentication/429 errors before malformed-body errors. The generic source helper no longer accepts composite identity discriminators.

PostgreSQL uses database time read after locking the quota row, so an application replica's clock jump cannot reset a shared allowance. Bounded input validation, SQL lock/statement deadlines and failed-client disposal were added. Existing shared source limits can throttle unrelated clients behind a NAT, while account limits can be targeted; these controls do not replace proxy sanitation, edge DDoS protection or future quota-retention maintenance. Changed bucket namespaces start fresh at rollout; drain old writers and deploy consistently to avoid mixed-version enforcement. Successful and unsuccessful attempts count. Retry headers describe the last checked bucket, not all available allowances.

Verification: `npm test` passes 244 tests, zero failures/skips, including live PostgreSQL; `git diff --check` passes. Twenty-two new tests exercise IP/body rotation, pre-authentication throttling, malformed/content-type requests, agent/event limits, real PostgreSQL concurrency across limiter instances, clock-skew recovery, failed-client disposal and allowed-frontend header visibility. Configured origins can read quota/retry headers through CORS without opening access to other origins. GitHub Actions has a dedicated quota step. Existing ownership tests now rotate sources to isolate identity limits; resource fixtures supply a limiter because parsing is no longer the first operation. Blockchain contract/publisher/finality, operator visibility, reviewed risk enforcement, legitimate datasets and hosted key/recovery acceptance remain unfinished. No remote CI, deployment or push is claimed.

Default allowances below are independently applied to each source and the listed identity, not multiplied together. Existing environment settings can override the configured financial/auth limits. Token/sync defaults intentionally cap the entire configured service; they need reviewed capacity settings before multi-user deployment.

| Route group | Default allowance | Additional identity |
| --- | --- | --- |
| Registration | 5 per 15 minutes | None before enrollment |
| Login / logout-all | 5 per 15 minutes per route | Hashed account / signed user |
| Authorization | 12 per minute | Authenticated wallet |
| Execution | 20 per minute | Authenticated wallet |
| Token issue / sync | 6 per 10 minutes per route | Single configured service |
| Risk / evidence / audit reads | 30 per minute per route | Authenticated wallet |
| Events / stream | 60 / 6 per minute | Authenticated wallet |
| Agent management / intent operations | Source 30 per minute, identity 20 | Owner wallet / agent |
| Agent identity lookup | 30 per minute | Agent |

### V2.3 Durable Verified Audit Batches and Proof API: 12 October 2026

Added `src/persistence/auditBatches.ts`, a finite `audit:batch` command and immutable `rail_audit_batches`/`rail_audit_memberships`. Leaves bind existing randomized authenticated payment commitments and required protected-risk commitments, not raw financial data. Helpers now reject sparse/oversized leaves and malformed proof shapes. Generic construction caps at 1,024 leaves; the worker accepts 1-256 pending records (default 128). No new dependency or chain provider was added.

Protected evidence inserts an indexed pending job inside the financial commit; queue failure rolls back money/token/evidence/risk/replay. Migration queues existing protected ciphertext without rewriting it, while legacy unprotected executions stay excluded. Batch construction uses a separate one-client transaction and shared advisory lock. It verifies retained envelopes, inserts root/count and all unique immutable memberships/proofs, consumes queued work and waits for final commit before reporting success. Deferred constraints enforce count/index/bindings, required risk evidence and queue consumption. Partial writes, final-commit failure and real backend termination restore pending work without undoing completed payments. Missing keys or corrupt records halt batching rather than silently skipping history.

`GET /v1/payments/:txId/audit` filters sender/receiver access, returns identical missing/inaccessible 404s and non-cacheable responses, and verifies the record/proof before disclosure. The participant receives only its own leaf, ciphertext commitments, sibling hashes, index/count and batch root/ID. Failure suppresses proof data. It reports `unanchored`/`local_only`, never chain confirmation or settlement. A new IP-rotation regression exposed the composite quota helper's identity-reset behavior; audit reads now use independent source and wallet-wide limits. Older risk/evidence and financial-route composite quotas need their own hardening follow-up; this finding is not hidden by passing audit tests.

Verification: 222 local tests pass, zero failures/skips. Seventeen added cases cover protected leaf bindings, sparse/malformed/bounded helpers, odd online/offline batches, concurrent bounded workers, legacy exclusion, partial/deferred/crash rollback, key retention, tampered envelopes/roots/proofs, incomplete/unbound membership and queue consumption, participant privacy/IP-rotation quotas, pre-authentication invalid-credential throttling, financial enqueue rollback, retained-history migration and safe finite CLI behavior. GitHub Actions has explicit audit coverage but is not remotely run for this revision. No testnet contract, signer, publisher, fee approval, finality/reorg tracker or independent checkpoint exists yet. Quota follow-up, full chain integration, operator visibility and real-data/deployment/key-recovery gates remain open; the full V2 goal remains active.

### V2.2 Explainable Anomaly Reference Baseline: 12 October 2026

Added `src/risk/anomalyRisk.ts`, a fitted median/MAD reference-distance baseline over the nine non-intercept behavioural dimensions. It complements logistic inference rather than replacing it. Training fits medians/scales, a later calibration cohort sets an experimental nearest-rank p95 threshold with floor three, and later test observations affect neither. Scale flooring and capped named contributions keep constant/binary dimensions and extreme valid inputs finite. This is unusualness relative to a supplied reference cohort, not a fraud probability, neural network, false-positive guarantee or automatic payment decision. Correlated dimensions, narrow/contaminated references and declared source/history provenance require independent evaluation.

The existing `risk:train` CLI now accepts `behaviour-anomaly-v1` datasets with ordered/disjoint training, calibration and test cohorts (20-10,000 rows each). Rows reuse strict feature validation and require sufficient nontruncated history. Metadata binds model/dataset versions, serialized input hash, currency, synthetic/reference-source status and calibration cutoff. Dense finite artifact parameters are copied and bounded. Private output refuses overwrite; reports contain aggregate distance/alert statistics, explicit unavailable fraud accuracy and separately measured bounded local-inference latency. No default artifact or authentic reference cohort was fabricated.

Optional `RAIL_ANOMALY_MODEL_PATH` loads a validated 1-MiB-bounded artifact before pool creation. Runtime uses the already trusted financial-client features after locking. Cold start/truncation, currency mismatch and future cutoff produce explicit unavailable states, not substituted scores. Full anomaly prediction/hash lives only in the encrypted risk record. The additive SQL summary is constrained to status/version/synthetic fields and authenticated before participant disclosure; completed replay keeps the original snapshot. Older protected records without the optional anomaly field remain verifiable as `not_configured` without rewriting ciphertext. No anomaly flag denies a transfer, approves an agent or modifies offline authority.

Verification: 205 local tests pass, zero failures/skips, including PostgreSQL. Thirteen added cases cover finite constant references, outlier resistance/deterministic fitting, calibration/test separation, chronology/duplicate/provenance/bounds, malformed/sparse artifacts, incomplete/future inference, clipping, private CLI/no-overwrite, bounded inference benchmarks, old encrypted-record compatibility, trusted runtime coexistence/replay, explicit unavailable models, summary tampering/plaintext-field rejection/atomic write rollback and startup validation. The first run's privacy assertion accidentally matched the synthetic warning prefix; it now checks actual event IDs. GitHub Actions has explicit anomaly coverage, not yet remotely run. Reports document algorithm/source and operational limitations. Durable audit batching/contract/worker, operator UI, legitimate labels, reviewed enforcement and real hosted/provider/key-recovery acceptance remain open; this is not full V2 completion.

### V2.2 Atomic Protected Risk Records: 12 October 2026

Added `src/persistence/riskProtection.ts` and mandatory HTTP configuration `RAIL_RISK_RECORD_KEY_RING`. A purpose-bound AES-256-GCM envelope with independently keyed HMAC-SHA256 retains detailed features, assessment, model provenance and predictions. HTTP startup rejects absent/malformed rings and material shared with any configured payment-evidence version. No existing secrets were silently replaced. This is application-loaded symmetric encryption, not a public signature, KMS or whole-database encryption.

The risk store shares the financial client. New protected observation rows retain no plaintext feature snapshot, model hash or prediction; the older probability-bearing shadow event is suppressed. Clear time, explanation and model availability/version/synthetic summaries remain queryable but participant reads verify them against the protected record before exposing them. Missing keys or tampering returns `verification_unavailable` without an assessment. Historical plaintext observations remain explicitly `legacy_plaintext`, and absent observations remain `legacy_unobserved`; no history was deleted or silently backfilled.

Immutable ciphertext, fingerprint binding, per-encryption-key committed-record quotas, nonce uniqueness and deferred required-record checks prevent partial financial commits. Failure rolls back wallet/token/ledger state, agent budget consumption, replay and key quota. Concurrent replay retains one original record; retained-key rotation preserves verification. The quota counts committed records, not all failed encryption invocations. Secret inventory, attempt monitoring, retention, historical migration, least-privilege roles and isolated key restore remain operational gates. Stop/drain older writers, apply migrations and provision both independent rings before HTTP cutover.

Verification: 192 local tests pass, zero failures/skips, including live PostgreSQL. Twelve new cases cover envelope/binding/GCM/HMAC tampering, key independence, size bounds, rotation/missing keys, immutable storage, plaintext/event-copy suppression, rollback/quota exhaustion, deferred required-envelope checks, summary tampering, startup guards and explicit offline/agent failure-retry paths. Existing participant API coverage now reads verified protected summaries. An intermediate offline fixture used a Web Crypto API where Node's imported `randomBytes` was required; the fixture was corrected and the entire suite rerun. GitHub Actions includes an explicit risk-protection step; this revision has not run remotely or deployed. V2 remains incomplete: anomaly-baseline work, durable audit batches/worker/contract, operator visibility and real-label/provider/recovery acceptance are still open.

### V2.2 Bounded Behavioural Drift Diagnostics: 12 October 2026

Added a finite `risk:monitor` command and `behaviourMonitoring.ts`. The operator supplies one expanded model and ordered, distinct reference/current cohorts; validation rejects repeated events, mismatched currencies, invalid features, observations at/before training cutoff and overlapping periods. Input uses the existing 20-MiB reader cap and at most 10,000 rows per cohort. Fewer than twenty samples returns `insufficient_data` without fabricating a stability conclusion. Supplied source declarations remain unverified; this tool is not an authenticated PostgreSQL exporter.

The diagnostic compares nine non-intercept feature distributions and model probabilities through fixed ten-bucket PSI with half-count smoothing, and reports history/budget missingness. Its fixed 0.2 shift threshold is experimental, not a validated fraud or significance threshold. Output contains aggregate counts/distributions and model version/hash, omitting event IDs and individual timestamps. Calibration/accuracy drift is explicitly unavailable without independent outcome labels. No detected shift does not certify safety, and a shift does not prove fraud. Operators must protect cohorts and aggregate reports; the twenty-row floor does not establish privacy or adequate statistical power.

Exit codes support finite operational checks: 0 no detected shift, 2 shift, 3 insufficient samples, 1 invalid input. The command never rewrites inputs, updates models or changes money/policy; no scheduler, alert delivery or retraining was silently configured. Review also sanitized shared JSON parser errors so malformed private dataset/artifact content cannot appear in error messages. Verification: 180 local tests pass, zero failures/skips, including existing PostgreSQL integration. Six added cases cover unchanged/shifted cohorts, sample insufficiency, time/identity/currency/provenance/bounds, missingness/finite smoothing and CLI codes/input preservation; existing artifact-read coverage additionally checks generic private-input errors. GitHub Actions includes explicit drift coverage but this revision is not remotely run or deployed. Protected risk records, legitimate labels, live monitoring acceptance, blockchain integration and operator UI remain unfinished; the full V2 goal stays active.

### V2.2 Expanded Behavioural ML and Temporal Evaluation: 12 October 2026

Added `src/risk/behaviourModel.ts`, a ten-feature logistic model covering trusted history/velocity, amount deviation, recipient familiarity, agent exposure and explicit missing-history/budget indicators. It shares a bounded deterministic gradient trainer with the legacy amount/channel model rather than adding a network inference dependency. Named contributions explain log odds, not causation. Expanded artifact validation binds feature schema, model/dataset versions, serialized-dataset hash, currency, synthetic status, training count, label-availability cutoff and finite copied weights. Review additionally fixed sparse-array validation that could otherwise allow missing weights/vector elements through JavaScript array predicates.

The existing `risk:train` command now accepts `behaviour-v1` datasets with chronological training, validation and test arrays, globally unique event references, source declarations and canonical observation/label timestamps. Training labels must be available before validation observations, and validation labels before test observations. Only training rows fit weights. Reports include held-out log loss, Brier score, confusion counts, precision/recall, false-positive rate, tied-score-safe average precision and calibration bins/error. A bounded warmed benchmark reports local inference median/p95/max separately from deterministic evaluation; it is not SQL/network/end-to-end latency. Synthetic reports explicitly disclaim real fraud validation. Source/timestamp declarations and hashes do not establish honest labels or independent feature provenance.

Optional `RAIL_BEHAVIOUR_MODEL_PATH` selects expanded inference after trusted feature collection and financial locks. The legacy path remains supported. Expanded configuration takes precedence without silent fallback; currency mismatch or a future/not-earlier training cutoff records an explicit unavailable status and no probability. Invalid configured artifacts fail startup before runtime creation. Runtime reads are capped at 1 MiB, dataset reads at 20 MiB and each split at 10,000 rows. Output artifacts are created with mode 0600 and refuse overwrite. Committed predictions/version/hash remain unchanged across retry, rollback or replacement of the configured model. The `risk.behaviour` stage emits lifecycle events in the payment commit.

Verification: 174 local tests pass, zero failures/skips, including PostgreSQL. Fifteen new cases cover learning from history with identical amount/channel, deterministic fitting without held-out label leakage, chronology/provenance, cold start/truncation, corrupt/sparse artifacts, temporal inference, tied-score/calibration reporting, bounded benchmark/IO, CLI permissions/overwrite, database-derived runtime predictions, replay/preference/unavailable-model behavior and startup rejection. No real fraud dataset or default production model was fabricated; tests use clearly labelled synthetic fixtures. GitHub Actions includes an explicit expanded-model step but this revision has not run remotely or deployed. Reports and dataset/runtime guidance are updated. Drift monitoring, protected risk-record retention, independently reviewed labels, blockchain batches/worker/contract, operator UI and production recovery/provider gates remain open; the overall V2 scope is not complete.

### V2.2 Trusted Behavioural Observation Foundation: 11 October 2026

Added `src/risk/behaviourRisk.ts` and immutable, fingerprint-bound `rail_risk_observations`. The standard online/offline/agent pipeline now captures database-derived history after authority/token verification and sorted wallet locks, before the current ledger posting. A database-clock 30-day window and indexed 1,001-row query produce a maximum 1,000-sample snapshot with explicit truncation. Client event timestamps, confidence/history claims and unverified device identity cannot create trusted history. Earlier rows visible in the same supplied-client transaction are included; stored execution timestamps are not exact outer-commit times.

Features record sampled five-minute velocity, sample-local recipient familiarity, mean amount, amount ratio/deviation and persisted agent held-plus-spent exposure. Welford statistics avoid artificial variance for identical amounts. Cold start, truncated history and unassessed device changes are explicit. A versioned deterministic shadow policy produces explanation codes; it does not block, authorize or fund a payment. The existing optional logistic model remains amount/channel-only, now snapshotted at pipeline construction with version, artifact hash, synthetic status and prediction retained privately. Missing configuration and currency mismatch store explicit statuses, not fabricated probabilities. Expanded model training/evaluation is still pending.

New standard-pipeline executions require their observation at final commit, so observation failure rolls back money and replay. Immutable snapshots survive retries and model changes without rescoring. `GET /v1/payments/:txId/risk` exposes only a participant-authorized, non-cacheable summary with safe explanation codes and model availability. Missing/inaccessible payments both return 404; reads use a 30/minute wallet/source quota. Historical payments remain `legacy_unobserved`. Feature records are sensitive relational data, not currently covered by the AES/HMAC transaction envelope; this distinction and retention/access requirements are documented.

Verification: 159 local tests pass with zero failures/skips, including PostgreSQL. Ten new policy/collector/integration cases cover database time, ignored client claims, bounded samples, velocity/deviation, model snapshot/replay immutability, currency mismatch, concurrent predecessors, write rollback, deferred missing-observation rejection and participant/privacy/quota handling. Existing agent tests additionally check mandate exposure, one snapshot on concurrent replay and observation rollback with evidence failure. The first integration run found an artificial constant-amount variance caused by floating-point mean accumulation; Welford's algorithm fixed the defect without relaxing the assertions. GitHub Actions has an explicit behavioural observation step, but remote CI and deployment have not run for this revision. No real fraud dataset, automatic enforcement or blockchain publication is claimed. Next code category is expanded explainable ML with reproducible temporal evaluation, while production key/recovery, historical accounting and provider gates remain open.

### V2.1 Atomic Agent Execution: 11 October 2026

Approved agent intents now execute online through `POST /v2/agent/intents/:intentId/execute`. The owner must explicitly issue a `payments:execute` credential; existing proposal credentials remain proposal-only. Execution requires the exact stored request fingerprint and rejects extra payload fields. Financial identities, amount, currency and generated transaction/replay identifiers come from the immutable intent, not agent instructions. The server signs the transaction with its private HMAC secret. Execution fails closed without a protected composable engine or a signing secret of at least 32 characters after trimming.

One PostgreSQL transaction now includes bound authorization, wallet movement, balanced ledger, mandatory AES/HMAC evidence, durable replay, mandate consumption, executed-intent receipt and outbox audit. Held budget moves into `spentBudgetMinor`; deferred constraints match both counters to intent state, require held plus spent within the total, and bind executed intents to accepted protected payments. The `rail_agent:` transaction namespace cannot commit without its corresponding executed intent. Terminal receipts cannot be edited, revived or rejected to restore consumed budget. Sorted wallet locks avoid sweeping unrelated expiry rows inside the agent payment scope; ordinary authorization cleanup remains operationally required.

Execution checks live credential, active agent, live mandate, exact approval, policy and funds before money movement, then rechecks deadlines after financial work. Revocation serializes against execution. Concurrent retries return one committed receipt without duplicating money, budget or evidence; replay also requires live authority. Owners retain historical visibility after revocation. Responses are emitted only after final commit, not after a provisional accepted engine result. Source and agent-global quotas also cover execution. Capability flags are state/runtime hints, not permission or funds guarantees. Existing device-bound offline/reconnect behavior is unchanged; agents execute online internal wallet transfers only, with no bank/UPI adapter.

Verification: 149 local tests pass with zero failures or skips, including live PostgreSQL. Thirteen added cases cover explicit scope, fail-closed signing configuration, exact approval/payload binding, concurrent one-connection replay, evidence/audit rollback, final deferred-commit rejection, deadline expiry during financial work, insufficient funds, ownership/revocation, HTTP quotas and database receipt/budget invariants. Migration rerun with executed history is covered. An intermediate run failed because fixtures inherited a short development signing secret; fixtures now use isolated test credentials and restore the original environment. The local development secret still needs an operator-managed replacement before agent execution is available; it was not silently changed. GitHub Actions runs the full agent file on its existing matrix, but this revision has not run remotely or been deployed. Public and ignored private reports track the change. ML is still synthetic/shadow-only; persisted blockchain anchoring, production key recovery, historical accounting, least-privilege roles and provider acceptance remain open.

### Transaction Composition and Offline Scope Review: 11 October 2026

Reviewed FlowPay's public description and two focused Kotlin components, not its complete application or a live bank transaction. Its repository describes a no-internet Android interface over existing USSD and voice rails. The [dial builder](https://raw.githubusercontent.com/Flowpayup/Payments-Without-Internet/main/app/src/main/java/com/flowpay/app/payment/Upi123CallStringBuilder.kt) constructs an IVR DTMF call, and the [session manager](https://raw.githubusercontent.com/Flowpayup/Payments-Without-Internet/main/app/src/main/java/com/flowpay/app/payment/PaymentSessionManager.kt) waits for SMS evidence rather than treating call duration as success. [NPCI's 123Pay booklet](https://www.npci.org.in/PDF/npci/upi-123pay/Product-Booklet.pdf) documents the underlying no-internet service. Carrier/bank coverage and FlowPay's live reliability were not verified. No third-party code was copied or integration implied.

Rail's offline scope is different: preissued authority, bounded device token headroom and server-side reconnect processing. Channel labels do not implement NFC/BLE hardware transport or prove final settlement without connectivity. README now distinguishes offline initiation from committed ledger state. Rail still has no live bank/UPI connector. The selected V2 direction is controlled agent authority, explainable risk and verifiable audit evidence, not replacing existing payment networks or claiming encryption/blockchain prevent every fraud.

Added trusted transaction-composition entry points: `createAuthorizationInTransaction`, PostgreSQL `dedupeInTransaction` and engine `executeInTransaction`. They reuse one caller-owned client, avoiding an independently committed authorization or nested checkout when assembling future agent execution. A small shared savepoint helper rejects autocommit before work begins, rolls back failed inner work and preserves earlier caller-owned writes. Existing standalone authorization/engine behavior retains its own commit boundary. Authorization timestamps now use one database clock sample; authorization and engine inputs are snapshotted before asynchronous work to prevent caller mutation from changing fingerprinted financial fields.

These methods are not permission checks. Their accepted result remains provisional until the outer transaction commits, including deferred financial constraints. The caller owns live agent/mandate/approval checks, lock ordering, SQL deadlines, rollback and client disposal; cached replay cannot bypass those authority checks. A failed payment scope rolls back that scope, not an earlier authorization outside its savepoint; the outer coordinator must roll back the whole operation on failure. No HTTP route exposes the composition methods, and agent `executionEnabled: false` remains unchanged. Mandate budget consumption and executed-intent bindings are still the next category.

Verification: all 136 local tests pass with zero failures/skips. Nine added tests cover autocommit rejection, outer rollback of authority/money/token/evidence/replay, one-connection committed execution, duplicate replay, evidence and SQL-event failure, input mutation, savepoint retry isolation, rejection of volatile composition and rollback when deferred checks reject a provisional accepted result at final commit. Initial focused assertions used the wrong offline-token table/column name; they were corrected before the full passing run. An explicit GitHub Actions composition step was added; this revision has not run remotely. Public and private reports were updated without exposing private scope files. Production key recovery, historical accounting and provider acceptance remain open.

### V2.1 Bound Intents, Approvals and Budget Holds: 11 October 2026

Added `rail_agent_intents` and a mandate `reserved_budget_minor` counter. Agents can propose requests through `POST /v2/agent/intents` and inspect them through `GET` on the same path. Owners use `GET /v2/agents/:agentId/intents` and `POST /v2/agents/:agentId/intents/:intentId/decision` with a current-version JWT. Agent credentials cannot approve requests or authenticate as owners. A separate 20/minute shared agent bucket spans credentials and source IPs, alongside the 30/minute source guard and existing owner-global quota.

Proposals validate recipient, currency, per-payment limit, live credential and mandate authority inside an agent-locked database transaction. Pending and approved intents reserve policy budget atomically; parallel proposals cannot exceed the mandate. Budgeted mandates preapprove an in-policy intent; approval-required mandates leave it pending for the owner. The approval fingerprint binds immutable identity, owner, mandate, recipient, money fields and timestamps. Reusing an agent-scoped client request ID with different data returns a conflict; identical retries return current state without another hold or extending the deadline.

Intent TTL defaults to 300 seconds, accepts 60-900 seconds and is capped by mandate expiry. Rejection, agent revocation, mandate revocation and transactional expiry cleanup release holds once. Rejected/expired intents cannot be resurrected. Intent/mandate reads and intent mutations clean expired holds lazily; no background expiry job was added, and failed transactions roll cleanup back. Revoking one credential prevents subsequent use of that token but does not cancel every agent intent. At most 1,000 intents are retained per agent, including terminal history.

Database constraints require each mandate's held budget to equal its pending/approved intent sum at commit. Immutable-history triggers reject edits to request bindings, terminal-state resurrection and deletion. State changes and outbox audits commit together; audit failure rolls both state and budget back. These checks assume runtime roles cannot disable triggers. Pending intent fields are not encrypted evidence; AES/HMAC protection still applies to committed payment evidence.

**Financial boundary:** `executionEnabled: false` remains explicit. These holds are mandate policy headroom, not wallet reservations or proof of available funds. No agent execute endpoint, wallet movement, ledger entry, authorization or consumed-budget lifecycle was added. Existing owner and offline execution remains unchanged. Next category is approved-intent execution with credential/mandate rechecks, budget consumption, money state, evidence and replay in one financial transaction. ML enforcement and blockchain publication remain pending.

Verification: the full local PostgreSQL-backed suite passes 127 tests with zero failures/skips. Twelve intent-category tests cover concurrent retries, payload conflicts, exact approval binding, ownership isolation, concurrent headroom, deadline cleanup, revocation races, shared quotas, database invariants and audit rollback. The initial added quota test incorrectly expected a response instead of the route's thrown `RateLimitError`; its assertion was corrected. An intermediate full run also hit a connection timeout in an existing history-protection fixture with a one-second checkout deadline; final verification was rerun without relaxing accounting assertions. GitHub Actions already executes the complete agent test file explicitly on Node 22/24; its step label now includes intents and approvals. This revision has not run remotely or been deployed. Public and ignored private reports were updated. Production key recovery, historical accounting and least-privilege roles remain open gates.

### V2.1 Agent Control Foundation: 11 October 2026

Implemented owner-managed agents, separate agent credentials and spending-mandate records. The new `rail_agents`, `rail_agent_credentials` and `rail_agent_mandates` tables bind identities and policies to existing wallets. Credentials contain 256 bits of random token material, are returned once, and are persisted only as SHA-256 hashes. Their current scope is fixed to `payments:propose`, with explicit expiry and revocation. Agent tokens cannot authenticate as owner JWTs or wallet API keys.

Owner control routes require a current-version user JWT through the explicit `resolveOwnerWallet` authentication method. Reads and writes share a PostgreSQL-backed 20-per-minute owner bucket without an IP or agent-ID component. Owner filtering precedes child-resource mutation. Agent introspection has a separate 30-per-minute source bucket. All responses use existing non-cacheable JSON handling; credential metadata and audit events contain no token. Revocation is checked on subsequent authentication, not a promise to cancel already authenticated work.

Mandates support `approval_required` and `budgeted`, positive minor-unit limits, a total budget not smaller than the per-payment limit, a matching owner/receiver currency, 1-20 distinct existing receivers, expiry and revocation. Self-payment policies are rejected. These are control records, not active payment authorization: every agent/mandate response says `executionEnabled: false`. No agent payment endpoint, exact-request approval lifecycle, budget reservation or budget consumption is enabled. Existing owner/offline financial execution is unchanged.

Agent-row locks serialize issuance/policy creation against revocation; revoking an agent revokes its credentials and mandates transactionally. Owner creation uses an advisory transaction lock to enforce a 50-retained-agent bound under concurrency. Each agent retains at most 100 credentials and 100 mandates, including expired/revoked records. Control mutations and their outbox audit events commit together under SQL deadlines; an audit failure rolls back the control change. This does not add an automatic retention/deletion policy or idempotent creation response.

Verification: all 115 local tests pass, with zero failures/skips. Twelve new tests cover malformed inputs, hashed/one-time credentials, separation from owner authentication, ownership isolation, database-clock expiry, revocation races, policy restrictions without money movement, audit rollback, concurrent capacity, database constraints, owner JWT version revocation and IP-independent shared management quotas. GitHub Actions includes an explicit agent-control step, but this unpushed revision has not run remotely. README, deployment guidance and the private report describe endpoints and remaining gates. V2.0 key recovery/deployment acceptance, historical accounting and production roles remain open. Next code category: exact intent approvals and atomic mandate-budget execution, before ML enforcement or blockchain anchoring.

### Documentation Organization: 10 October 2026

All 44 project Markdown files now live under `docs/`, including the repository README, public reports, technical guides, local manuals and ignored private plans. Four extracted historical documentation packs retain their separate names under `docs/archives/`, avoiding collisions or overwriting newer documents. Their ZIP archive and image assets remain in `deliverables/`. Dependency/build/Git directories were excluded from the move.

Document-to-document links remain relative within `docs/`; the README license link now resolves to the root `LICENSE`. The private scope and V2 report remain ignored, with an additional `docs/PRIVATE_*.md` rule protecting private Markdown in the new location. Previously untracked manuals and archive copies remain untracked. This changes documentation paths only, not the application runtime. Link targets, file inventory and Git ignore behavior were checked; runtime tests were not rerun for these moves.

### V2.0 Atomic Protected Evidence: 10 October 2026

The HTTP runtime now requires an explicitly configured `RAIL_EVIDENCE_KEY_RING` and supplies a transaction evidence store to the payment engine. Newly executed online and reconnect/offline payments encrypt the canonical audit copy with AES-256-GCM and authenticate its versioned envelope using a separate HMAC-SHA256 key. Evidence insertion uses the same database client and transaction as wallet, authorization, token, ledger, outbox and replay state. A required-evidence execution cannot commit without its fingerprint-bound evidence; evidence rows are immutable. Replays retain the original committed record rather than re-encrypting it.

The key ring validates versions and separate material, copies key buffers defensively, retains retired versions for verification and rejects missing/malformed configuration before opening a pool. A shared database counter caps committed records per encryption-key fingerprint at a configurable maximum of one million; quota exhaustion requires rotation. Unique key-fingerprint/nonces prevent duplicate committed nonce use. The counter rolls back with failed payments and is not a total encryption-invocation counter. Operational attempt limits, secure key retention/recovery and production KMS support remain open.

`GET /v1/payments/:txId/evidence` authenticates the caller and filters sender/receiver access in SQL. It returns only `verified` plus a commitment, `legacy_unprotected`, or `verification_unavailable` with a safe reason. Missing and unauthorized payments both return 404. Reads have a 30-per-minute wallet/source bucket and non-cacheable responses; plaintext, ciphertext and keys are not exposed. Historical successful replays stay unchanged and are not silently backfilled.

Verification: `npm test` passes 103 tests with zero failures or skips, including live PostgreSQL tests for concurrent offline evidence/replay, online endpoint access and throttling, injected rollback, missing-evidence commit rejection, retained/removed key versions, legacy replay and quota exhaustion. GitHub Actions now includes explicit crypto/key and evidence-integration steps on the existing Node 22/24 matrix; this revision has not been pushed or remotely run. README and deployment instructions document the required configuration and stop/drain cutover. Older writers and optional library/demo engines can still create legacy executions; a mixed-version rollout is not evidence-complete.

This increment protects the canonical audit copy, not all database fields or existing event payloads. It does not enable ML enforcement, agent mandates, public signatures or blockchain publication. Historical accounting review, external funding/reversals, least-privilege roles, provider deployment and real key-backup/restore remain independent release gates.

### Private Implementation Report: 10 October 2026

Created a separate Git-ignored V2 implementation status report documenting the current baseline, direct next changes, dependent milestones, acceptance checks and deferred research. This is a planning/documentation update only: no payment behavior changed, no integration was marked complete, and no production gate was closed. The private roadmap and its new report remain outside the repository.

### Version Scope Baseline: 10 October 2026

Consolidated the next-version plan in the ignored private project scope document, separating required delivery milestones from speculative research. Offline capability, device/request bindings and atomic PostgreSQL accounting remain foundational. Implementation will proceed through independently tested categories; future work is not classified as delivered by this planning update. The detailed private roadmap remains excluded from version control. Existing V1 historical-data and production gates remain unchanged.

### V2 Authenticated Encryption Foundation: 10 October 2026

Added `src/crypto/transactionProtection.ts` and six tests in `test/transactionProtection.test.js`. The exported server-side primitive encrypts the existing canonical, authorization-bound transaction using AES-256-GCM with a fresh 96-bit nonce and 128-bit authentication tag. A separate 256-bit key produces an HMAC-SHA256 over the versioned envelope, including metadata, ciphertext and tag. Equal encryption/authentication keys and malformed key material are rejected. Decryption checks the caller's trusted transaction ID and request fingerprint, verifies the HMAC and GCM tag, and verifies the recovered payload fingerprint before returning it.

This is a tested foundation, not an enabled production encryption migration. No routes, database records, existing HMAC requirements or payment decisions were changed. Keys must remain server-side; client/device authentication still needs its own credential design. GCM already authenticates ciphertext; the additional HMAC is a separately keyed envelope attestation, not a public digital signature or non-repudiation mechanism. TLS remains necessary. A ciphertext commitment can enter the existing Merkle helper, but that hash helper neither authenticates records nor publishes anything to a blockchain. Callers must verify and persist a single envelope before batching it.

The existing logistic model remains shadow-only and trained/evaluated with synthetic demonstration data; it is not a validated fraud classifier. The proposed next design preserves offline/device bindings and atomic ledger execution, adds owner-approved agent mandates with approval-required and budgeted modes, and uses blockchain audit anchoring rather than moving funds on-chain. Detailed phases and acceptance gates remain in the ignored private scope file. No contract was deployed, no chain fees were incurred, and no customer data was published.

Verification: `npm test` passes all 92 tests, including PostgreSQL integration, with zero failures or skips. New coverage checks round-trip protection, fresh nonces, envelope/binding tampering, independent GCM verification, key separation and Merkle proof compatibility. Existing V1 historical-data and production release gates remain open.

### V1 Redundancy and Acceptance Review: 10 October 2026

Removed the unused saga coordinator/export, unused stage timeout/retry wrappers, duplicate pipeline builder and redundant catch/rethrow. The HTTP context now requires PostgreSQL explicitly and no longer advertises a memory idempotency union or query-credential options. The placeholder HSM module/export is removed; one configuration guard rejects unsupported providers. README diagrams and the current execution description now show a single database commit, not compensating sagas.

The unsafe timeout wrapper was unused by the financial path; removing it does not introduce a new promise race around commit. SQL deadlines and durable fingerprint-bound retries remain the recovery mechanism for uncertain responses. Tested retry/semaphore utilities and memory test implementations remain because they serve distinct roles, not duplicate payment runtimes.

[V1_SIGN_OFF.md](V1_SIGN_OFF.md) records the verified scope, 86-test acceptance evidence, removals and unresolved owner/data/deployment gates. Overall release remains pending scope confirmation; historical accounting failures and real-money prerequisites are not reclassified as fixed. Private manuals/deliverables and the existing `.gitignore` edits were preserved.

### V1 Authentication Closure: 10 October 2026

Login now consumes a second shared quota keyed by a hash of the account identifier without an IP component, preventing source-address rotation from bypassing account limits. Both successful and failed attempts count; the default is five attempts per 15 minutes, not a permanent or adaptive lockout. JWTs carry `authVersion`, require integer issuance/expiry values and a maximum 15-minute lifetime, and authentication checks the stored version. Old versionless tokens must log in again.

`POST /auth/logout-all` uses a bearer token and atomically advances the stored version, invalidating previous tokens on subsequent requests across instances. Concurrent/repeated revocations cannot increment the version with a stale token. Login after revocation issues the new version. In-flight authenticated payments are not cancelled. API-key rotation and password recovery remain separate operations; operator password resets must increment the version too.

Registration now uses database deadlines and discards clients after connection/rollback failures. Production configuration cannot enable internal error exposure. Unimplemented KMS/PKCS#11 settings fail closed instead of advertising unavailable protection. Four new regressions bring the suite to 86 passing tests with no skips. Release scope and the historical accounting decision still require explicit owner confirmation; no existing financial records were rewritten.

### CI Runtime Review: 10 October 2026

The successful demo-fix CI run reported deprecated Node 20 action runtimes and an upcoming `ubuntu-latest` image change. The workflow now pins verified official checkout/setup-node release commits, disables persisted checkout credentials, selects Ubuntu 24.04 explicitly and runs the full PostgreSQL-backed suite on Node 22 and 24 independently. Read-only repository permissions and the ten-minute job limit remain unchanged. Version upgrades must deliberately review the pinned action SHAs rather than silently following mutable major tags.

Runtime changes were checked against the [official checkout documentation](https://github.com/actions/checkout), [setup-node documentation](https://github.com/actions/setup-node) and [Node release schedule](https://nodejs.org/en/about/previous-releases). The local shell still runs Node 20; the supported-runtime matrix is therefore a separate remote verification, not a claim about the local interpreter. These CI changes do not close production deployment or accounting release gates.

### Demo Acceptance Review: 10 October 2026

The old demo reused fixed wallet/payment IDs in the configured database while generating a new request timestamp on each invocation. A second run could therefore collide with its completed fingerprint, and synthetic funds could coexist with historical data. The demo now requires explicit `RAIL_DEMO_MODE=true`, refuses production mode, and confines all synthetic wallets/payments to a new random schema. It removes only that schema on completion and closes its pools even on failure.

The demo verifies authorization-first execution, identical replay results, sender/receiver balances and clean reconciliation. Two new regressions verify the safety gate and two successive independent runs with no leftover demo schemas. The full suite now contains 82 passing tests without skips. A separate command-line run also returned accepted/replayed results, sender balance 85,000 and receiver balance 15,000 minor units, zero reservations and zero reconciliation issues. No existing historical wallet or accounting finding is repaired or deleted by this demonstration.

### Runtime Contract Review: 10 October 2026

The HTTP application now requires a nonblank `DATABASE_URL` in development as well as production. It no longer boots an incomplete memory mode while authentication and money execution depend on PostgreSQL. The composition always selects durable token, idempotency and rate-limit stores. If local startup migrations fail, the new pool is closed before the error propagates. Memory components remain available for isolated tests and examples; earlier descriptions of a fallback runtime below are historical, not current deployment instructions.

A startup regression covers missing and blank database configuration. The full local suite now passes 80 tests without skips. `/health` reports process liveness/configuration only: it is not a database-readiness, accounting or settlement acceptance test. Provider deployment and the historical reconciliation decision remain outstanding.

### Request and Resource Review: 10 October 2026

JSON readers now have an absolute configurable deadline (`RAIL_REQUEST_BODY_TIMEOUT_MS`, default 10 seconds), handle interrupted bodies, release listeners/buffers and pause rejected uploads. The HTTP handler flushes 413/408 JSON errors before closing an unread connection. Real socket tests verify both responses rather than only testing an error object.

Memory diagnostic dead letters retain the latest 1,000 items and return defensive copies. Development idempotency caps records at 10,000 without evicting replay results, rejects new keys at capacity, isolates returned result objects, and correctly retries a synchronously thrown failure. The memory rate limiter caps identities, expires buckets using their own window and fails closed when full. These are local safeguards, not replacements for durable PostgreSQL state or deployment-level denial-of-service protection.

Eight new regressions bring the suite to 79 passing tests with no skips. GitHub Actions explicitly reruns resource tests as well as the full suite. Financial retention cleanup, production proxy limits and the remaining authentication/deployment gates are still open.

### Event Delivery Review: 10 October 2026

Wallet-visible history now filters committed outbox rows in SQL before applying limits, with wallet lookup indexes and stable event IDs. REST accepts a bounded limit and an older-page cursor, and returns `nextBefore`. Failed outbox writes propagate errors instead of producing phantom live events. Operational errors stay in server logs rather than being inserted and broadcast twice.

Persistent-server SSE now polls the shared committed database every two seconds, checks credentials again, and cleans up on read errors, disconnects, slow consumers and a 60-second lifetime. Admission is capped at two streams per wallet and 64 per process; event routes also apply shared rate limits. Serverless SSE remains disabled. This is deliberately an advisory UI snapshot feed: bursts beyond its latest-100 window and commit-order differences require REST refresh/pagination and ID deduplication, not a claim of exactly-once delivery.

Nine new regressions cover failed persistence, malformed cursors, wallet isolation under noisy traffic, equal-timestamp paging, uncommitted-row invisibility across instances, admission, initial read failure, backpressure and later credential failure. The full suite now contains 71 tests. The historical accounting findings and remaining V1 release gates below are unchanged; ML/V2 development is still deferred.

### Accounting Review: 10 October 2026

Wallet accounting now has explicit opening balances and immutable baseline/identity fields. New wallets capture their starting state; registration remains zero-funded. Historical wallets retain a missing baseline rather than receiving an inferred value. Deferred database checks enforce both equations: available plus reserved equals opening balance plus ledger credits minus debits; reserved equals all still-issued authorization amounts, including expired reservations awaiting release. Baseline-less financial mutations fail closed with a safe `503 accounting_review_required` response. A maintenance command can record an independently reviewed opening amount and reference once, but refuses unresolved wallet-related findings or a value that does not satisfy the equations. This is not verification of external bank funding.

Reconciliation now checks wallet drift, reservation totals, currency, authorization-bound ledger entries, usage, execution and replay records in one read-only MVCC snapshot. It uses transaction deadlines and bounded reports with an explicit truncation finding. The `npm run accounting:reconcile` job exits nonzero on findings and never repairs money. Tests cover concurrent payment snapshots, rejected drift/baseline edits, preserved legacy baselines and cross-currency historical errors. The current local suite passes 62 tests with no skips; dependency audit reports zero known advisories.

The existing local development database is not a clean acceptance dataset: a read-only scan produced 161 findings across unmatched authorization/ledger state, orphan usage, a reservation discrepancy and three missing opening balances. Findings can overlap on a transaction; they are not a count of successful exploits. Existing financial history has not been deleted or rewritten. Dataset disposition and evidence-based reconciliation require an explicit decision. V1 acceptance is still pending; controlled funding/refunds/reversals, authentication lifecycle, event delivery/resource limits, device trust and deployment permissions also remain open before V2 enhancement work.

New payments now have database-enforced commit checks: the used authorization, debit/credit pair, currency, amount, sender/receiver, usage identity, execution record and matching completed replay result must agree before commit. Posted ledger, usage and execution rows reject update/delete, and used authorization financial fields cannot be rewritten or reset for reuse. Two unused wallet stores with conflicting accounting conventions were removed; live wallet mutations remain in the typed authorization helpers inside the shared payment transaction. Builds regenerate `dist` from scratch so removed source files do not leave stale executable modules. Payment integration tests now use disposable schemas rather than deleting financial history. Fault-injection tests verify rollback for incomplete/mismatched commits and rejection of posted-history edits. Opening-balance reconciliation, controlled reversal/refund lifecycle and production database-role permissions remain required work.

Schema migrations now identify constraints by relation, not merely by a database-wide name. Legacy API-key detection is scoped to the current schema. Runtime and outbox migrations execute under a shared transaction-scoped advisory lock, with lock/statement deadlines, rollback and failed-client disposal. PostgreSQL regression tests prove local constraints are enforced even when another schema has the same names, unrelated legacy tables remain untouched, concurrent migrators complete safely and invalid historical data does not leave partially installed runtime tables. The full local suite passes 53 tests without skips.

Authorization expiry no longer depends solely on an in-process timer: reading an authorization releases its expired reservation in the same transaction, and issuance first reclaims expired sender reservations. Locked rows and guarded wallet updates prevent duplicate releases; failed release leaves the authorization unchanged for investigation. Execution checks the current database clock rather than the transaction-start timestamp. Authorization functions now receive their database pool explicitly, removing cross-context global state, and money helpers use typed clients and reject invalid amounts. The bounded `npm run authorizations:sweep` command is available for an operator-managed schedule, including serverless deployments. New PostgreSQL tests cover concurrent reads/sweeps, reusing released headroom, invalid helper inputs, atomic failure and expiry during an open transaction; production job scheduling remains unverified.

Offline-token headroom now has an explicit reserved/finalized/rolled-back lifecycle. Both storage backends validate direct-call amounts, token caps, binding identifiers and issuance lifetimes. Repeating a reservation does not debit headroom twice; rollback restores only the matching still-reserved amount, once, and cannot refund finalized payments. PostgreSQL persists payload fingerprints in `rail_offline_spends`, using the same transaction client as payment execution. Tokens are retained after exhaustion/expiry to preserve spend references; a reviewed retention policy is still required. Existing unrecorded reservations are not automatically refunded. The full local suite passes 46 tests with PostgreSQL integration tests enabled; these files are included in the existing GitHub Actions test command.

Outbox delivery now has durable pending/processing/delivered/dead-letter states, attempts, retry deadlines, lease ownership and acknowledgement timestamps. Concurrent workers claim rows with SKIP LOCKED; expired leases recover, exhausted attempts stop retrying and adapter calls have deadlines. A one-shot HTTPS webhook worker uses stable event IDs as idempotency keys and never follows redirects carrying credentials. Tests cover parallel exclusion, stable retry IDs, acknowledgement, dead letters, worker-crash lease recovery and adapters that ignore cancellation. An operator must schedule the worker and configure a trusted receiver; receiver deduplication is required for at-least-once delivery.

Payment execution now uses one PostgreSQL client and one transaction for authorization claim, wallet locks, offline headroom, ledger entries, transaction execution records, replay results and durable outbox inserts. Payment stages no longer acquire or commit their own connection, and events are buffered per execution. Transaction-scoped locks replace session locks, with local lock/statement deadlines and failed-client disposal. A real backend-termination test proves rollback and successful retry with a one-connection pool; HTTP replay after authorization expiry also passes.

Transaction and authorization canonical payloads now use versioned JSON arrays; transaction fingerprints bind authorization IDs. Existing completed fingerprints migrate only after matching the old unambiguous payload and verifying the used authorization plus balanced ledger. Historical rows lacking a fingerprint, or committed payments without a verifiable execution/replay record, require explicit reconciliation instead of guessed replay. Existing stored authorization references continue to be matched by their saved signature; newly signed requests use the new canonical format, so old client HMACs must be regenerated.

Production configuration now rejects service API keys shorter than 32 non-whitespace characters and requires an explicit proxy-trust setting even in serverless runtimes. JWT verification accepts only HS256, validates user claims and maps invalid/expired tokens to generic 401 responses; unknown API keys and deleted users also return 401. Tests cover production configuration, explicit proxy trust, token expiry, algorithm mismatch and missing credential owners. Account-level delays and session revocation remain tracked work.

Concurrency hardening reserves semaphore slots during FIFO handoff, makes release idempotent and bounds queued work. Retry cancellation now rejects already-aborted work, stops after abort and removes delay listeners on completion. Regression tests cover newcomer races, queue overflow, cancellation and listener cleanup. Timeout propagation across payment commits remains a separate open item.

Authorization hardening now checks sender, receiver, amount and currency in the transactional claim used by the engine. Transaction-scoped locking also serializes concurrent issuance for a previously absent transaction ID. PostgreSQL regression coverage confirms eight simultaneous retries return the same authorization and reserve exactly once. Crash recovery and serverless expiry remain tracked separately until their tests pass.

On 8 October 2026, upgrade work began. At the owner's direction, the initial commits were moved to `main` and the temporary Codex branch was removed. All subsequent fixes use small descriptive commits directly on `main`; additional ML development is deferred until the security and correctness backlog is resolved. The original offline-capable payment flow remains the foundation. Current findings, fixed issues and release gates are tracked in [SECURITY_REVIEW.md](./SECURITY_REVIEW.md). Earlier phase descriptions remain historical records, not a claim that every financial-system safeguard is complete.

The first V2 security pass prevents registration from claiming existing wallets, applies login/registration limits across usernames per IP, validates JSON object boundaries and enforces bcrypt's 72-byte password limit. Existing oversized passwords need a reset policy rather than silently changing hashes. Tests exercise wallet ownership against PostgreSQL, rotating usernames and invalid/multibyte inputs.

The V2 ML baseline now implements trainable logistic regression, artifact/provenance validation, held-out evaluation and optional shadow observations. The transaction-ID-based placeholder has been removed. No real fraud dataset or default model is supplied, and there is no enforced fraud policy. Observations cannot override authorization, wallet or token checks. See [V2_TECHNICAL_GUIDE.md](./V2_TECHNICAL_GUIDE.md) for dataset format, metrics and deployment instructions.

V2 also adds salted SHA-256 transaction commitments, batch-count-bound Merkle roots and inclusion proof verification. Tampering tests cover changed amounts, proof indices, batch counts and malformed proofs. These are standalone audit primitives; durable audit records, an anchoring worker and blockchain deployment remain future phases. No private payment records are published on-chain. The complete suite passes 26 tests locally, including four PostgreSQL integration tests. CI covers the V2 branch and exposes the new security, ML and audit tests explicitly.

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

- `docs/`
  All project Markdown, including README, deployment guidance, status reports and local supporting manuals. Private plans are ignored. Extracted historical packs are kept in `docs/archives/`; non-Markdown deliverables remain in `deliverables/`.
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
- `src/risk/`
  Validated logistic models, training/evaluation and trusted behavioural feature/observation collection.
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

- `src/crypto/transactionSigning.ts`
  Handles transaction signature helpers used during payment verification and integrity checks. Merchant signatures do not replace Rail's HMAC payment binding.

- `src/crypto/merchantQuotes.ts`
  Defines canonical checkout signing bytes, strict proof parsing, bounded operator recipient/public-key trust and historical Ed25519 attestation checks. It does not hold private merchant keys or move money.

### Domain Models

- `src/domain/authorization.ts`
  Defines the authorization domain model and related types. This file captures the shape of the authorization object that moves through the project.

- `src/domain/types.ts`
  Defines core project domain types such as payment transactions and pipeline result structures used across the engine, stages, and server.

### Persistence

- `src/persistence/migrate.ts`
  Contains PostgreSQL schema creation and migration logic. This includes the wallet, ledger, authorization, idempotency, and related persistence setup that the live server depends on.

- `src/persistence/postgresIdempotency.ts`
  Implements PostgreSQL-backed idempotency using database state and advisory locking. Supports its normal owned transaction and savepoint-isolated composition in a supplied transaction; composed results are not committed until the caller commits.

- `src/persistence/transaction.ts`
  Requires an existing PostgreSQL transaction and isolates composed work using a uniquely named savepoint. Does not own final commit, deadlines, authorization or pool-client disposal.

- `src/persistence/postgresOfflineTokenStore.ts`
  Implements PostgreSQL-backed storage for offline spend tokens and token headroom tracking.

- `src/persistence/postgresPool.ts`
  Creates and configures the PostgreSQL connection pool used by the server.

- `src/persistence/agentAuthority.ts`
  Stores owner-bound agents, hashed scoped credentials, mandates and fingerprint-bound intents. Serializes approvals, revocation and held/consumed budgets. Coordinates approved online execution with authorization, money, evidence, replay and audits in one transaction, returning receipts only after final commit.

- `src/persistence/reconciliation.ts`
  Performs snapshot-consistent accounting checks and validates evidence-referenced, one-time historical opening-balance records.

- `src/persistence/runReconciliation.ts`
  Runs the bounded read-only accounting report or the explicitly enabled operator baseline-recording command. Findings cause a nonzero exit for monitoring.

The unused `postgresWalletStore.ts` and `walletStore.ts` implementations were removed during accounting hardening. They used incompatible balance conventions and had no runtime callers. Wallet mutations now have one implementation in the typed helpers in `src/stages/authorizationStage.ts`.

### Pipeline Infrastructure

- `src/pipeline/backpressure.ts`
  Contains pipeline backpressure-related support logic for controlling execution pressure and protecting processing flow.

- `src/pipeline/context.ts`
  Defines the execution context object passed through pipeline stages.

- `src/pipeline/dlq.ts`
  Defines the dead-letter queue support used for failed pipeline runs.

- `src/pipeline/engine.ts`
  Coordinates idempotency, tracing, pipeline execution, evidence, events, DLQ behavior and result handling. Snapshots transaction fields and supports trusted execution inside a caller-owned transaction without enabling a new HTTP payment authority path.

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

- `src/server/routes/agentRoutes.ts`
  Handles owner-JWT-only control management and exact intent decisions with a shared owner quota, plus scoped-agent introspection, proposals and execution under source/agent quotas. Execution accepts only the bound fingerprint and returns the committed intent/payment receipt.

- `src/server/routes/paymentRoutes.ts`
  Contains payment authorization, offline token issuance, payment execution, and sync route handling.

- `src/server/routes/eventRoutes.ts`
  Contains the event listing and SSE stream endpoints.

### Audit and Risk Modules

- `src/persistence/auditBatches.ts`
  Verifies retained protected records, atomically builds bounded immutable batches and returns participant-filtered locally verified proofs.
- `src/persistence/runAuditBatch.ts`
  Runs one authorized bounded maintenance batch with retained keys, no chain network calls and sanitized failure output.
- `test/auditBatches.integration.test.js`
  Exercises queue/membership integrity, concurrency, migrations, financial rollback, worker termination, key loss, tampering, proof privacy/quotas and CLI behavior.

- `src/risk/anomalyRisk.ts`
  Fits a bounded median/MAD reference baseline, calibrates an experimental threshold, validates artifacts and reports explainable shadow distances and local inference timing.
- `test/anomalyRisk.test.js`
  Covers fitting/calibration separation, temporal/provenance limits, artifact validation, constant/extreme inputs, private CLI and inference bounds.

- `src/persistence/riskProtection.ts`
  Implements risk-purpose AES/GCM and HMAC envelopes, independent key-ring loading, atomic quotas/ciphertext persistence and authenticated summary verification.
- `test/riskProtection.test.js`
  Covers encrypted record round-trip, nonce freshness, tampered envelopes/bindings, GCM/HMAC independence, key separation and input limits.

- `src/risk/behaviourRisk.ts`
  Collects bounded database history, derives statistical/velocity/budget observations and persists immutable shadow assessments inside financial execution. Provides participant-filtered summary reads without raw features.
- `src/risk/logisticRisk.ts`
  Validates/copies the amount/channel artifact, provides bounded JSON reads and the shared deterministic logistic trainer, and implements legacy prediction/evaluation. Synthetic results do not prove real-world fraud performance.
- `src/risk/behaviourModel.ts`
  Validates expanded feature/model schemas, guards chronological label availability, trains from trusted-feature datasets and reports named contributions, held-out calibration/ranking metrics and bounded local inference timings.
- `src/risk/trainRisk.ts`
  Loads bounded private legacy or behavioural datasets, writes new mode-0600 artifacts without overwriting and prints evaluation/benchmark diagnostics.
- `src/risk/behaviourMonitoring.ts`
  Validates distinct temporal cohorts and produces bounded aggregate feature/probability PSI and missingness diagnostics without changing model or financial state.
- `src/risk/monitorRisk.ts`
  Reads a restricted-size supplied cohort file, prints an operator drift report and returns distinct shift/insufficient/invalid exit codes.
- `test/behaviourMonitoring.test.js`
  Tests drift/missingness, input bounds/provenance chronology, explicit insufficiency and CLI privacy/exit/input-preservation behavior.
- `test/behaviourModel.test.js`
  Tests expanded training, features, provenance/time leakage, calibration/ranking, sparse/invalid artifacts, deterministic weights and CLI/IO/benchmark bounds.
- `test/behaviourRisk.integration.test.js`
  Tests collection bounds, clock/provenance, history/concurrency, immutable replay, rollback, commit enforcement and participant-safe HTTP summaries.

### Business Stages

- `src/stages/authorizationStage.ts`
  Implements authorization creation/lookup, reservation release and wallet mutation helpers. Supports standalone issuance or savepoint-isolated issuance in a supplied transaction, snapshots input and signs database-clock timestamps.

- `src/stages/paymentPipeline.ts`
  Implements validation, prechecks and money/ledger changes within the idempotency-owned database transaction. No saga compensation runtime remains.

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
3. atomic funds, ledger, execution, outbox and replay commit

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

No enforced fraud engine is claimed. An optional model produces shadow observations only, not authorization decisions.

### Financial Transaction

The payment transaction performs:

- optional offline token reservation
- authorization claim inside the payment transaction
- sender reservation consumption
- receiver wallet credit
- ledger entry creation
- outbox event append
- offline token finalization
- execution and replay-result persistence
- commit all effects together or roll back all effects together

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

Six additional hardening tests were added for authorization-signature tampering, transaction-HMAC tampering, offline device binding and rollback, trusted proxy identity, configured-origin CORS behavior, and retryable versus terminal failures. A seventh regression test verifies that callers cannot mutate the in-memory offline-token state through returned objects. The GitHub workflow runs the full suite and invokes the hardening test file explicitly so this security coverage is visible as its own CI step.

The in-memory offline-token store now returns defensive copies from token issuance and reads. This prevents accidental or malicious mutation of token headroom, wallet ownership, or device binding outside the store's validation and mutex-protected operations.

## Shared Rate-Limit Hardening

On 8 October 2026, concurrent creation of a new bucket was corrected: the bucket is inserted before row locking, because PostgreSQL cannot lock a row that does not exist. A live integration test confirms twelve concurrent calls admit exactly three at a quota of three.

On 2026-08-30, durable PostgreSQL-backed rate limiting was added for database-backed deployments. Login, authorization, execution, token issuance, and synchronization now use a database bucket protected by row-level locking, so the quota is shared across warm instances instead of being limited to one process. Memory rate limiting remains available only for local development without PostgreSQL.

## Privileged API Scope Hardening

On 2026-08-30, privileged offline routes were separated by explicit API-key scopes. Offline-token issuance requires `offline_tokens:issue`, while reconnect synchronization requires `sync:write`. The scopes are configured through `RAIL_API_KEY_SCOPES`, documented in the environment example and deployment guide, and denied with `403` when the configured key is not authorized for a route.

## Proxy Identity and Runtime Identifier Hardening

On 2026-08-30, rate-limit client identity handling was made explicit. Forwarded IP headers are used only when the deployment is configured to trust a sanitizing proxy; local direct requests use the socket address, preventing arbitrary clients from choosing their own rate-limit identity. The engine also uses cryptographically secure UUIDs for trace and correlation identifiers instead of `Math.random()`.
