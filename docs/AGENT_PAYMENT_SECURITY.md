# Owner-Controlled Agent Payments

## Product Direction

Rail is a payment authorization and execution backend for owner-controlled AI agents and humans. It does not run a language model or assume that an agent's reasoning is trustworthy. Any software agent can submit a request; deterministic server-side policy decides whether it has authority to execute it.

The public positioning is: "Let agents handle the task. Keep the owner in control of the payment." An agent prompt is not the enforcement boundary. Stored authority and transactional accounting are. This is not a claim that Rail prevents every agent compromise or operator backdoor.

Human transfers retain their existing authenticated authorization path. Agent transfers use separate credentials and mandates, then share the same atomic financial engine. Offline token/device bindings remain supported; agent execution itself is online-only.

## Authority Boundaries

| Caller | Permitted role | Not permitted |
| --- | --- | --- |
| Owner with current user JWT | Create agents, issue scoped credentials, create/revoke mandates and decide exact intents | Override financial invariants or make a replay move money again |
| Proposal credential | Propose and inspect its agent's intents | Execute or change owner policies |
| Execution credential | Execute its agent's approved intent under live policy | Create its own authority, approve pending intents or override recipients/budgets |
| Privileged service key | Configured offline issuance/sync service operations | Act as an owner on agent-management endpoints |
| Risk model | Supply optional shadow diagnostics | Approve a payment or expand a budget |
| Audit worker | Batch authenticated committed evidence | Grant authority or move funds |

Agent deployment must exclude owner sessions, operator credentials, database credentials and server crypto keys. A token identifies authority, not whether the caller is human or a language model. If an agent steals an owner's JWT, Rail sees owner authority; credential isolation and stronger owner authentication are essential, separate controls.

[Owner passkey ceremonies and exact-operation grants](./OWNER_PASSKEYS.md) protect execution credential issuance, spending mandates, exact approvals, factor removal and recovery-code rotation. A JWT alone cannot perform these mutations. Recovery requires password plus an unused offline code, replaces the password, revokes sessions/factors/agent authority and permits only scoped new-key enrollment. Money/history is preserved. Emergency revocation remains available without a grant. Browser/hosted/custody/notification acceptance is unfinished; ordinary human transfers and compatibility library fixtures are not universally step-up-protected.

## Acknowledgement Has Two Explicit Modes

[Shared budgets](./SHARED_BUDGETS.md) optionally coordinate allowance across multiple
agents while retaining each agent's narrower mandate. Creation, limit changes and
new members require exact passkey consent; emergency withdrawal remains grant-free.
Pending approval already holds shared allowance. Internal lifecycle transitions
update both policy levels atomically. This is not a funded wallet or provider settlement.

1. `approval_required`: the owner approves the exact immutable request fingerprint. Changed recipients, amounts or currencies cannot reuse that approval.
2. `budgeted`: the owner gives advance permission for fixed recipients, currency, per-payment amount, total budget and expiry. The agent does not need another owner click for each in-policy payment. Users must understand this when creating the mandate.

Neither mode permits approvals to override policy or insufficient funds. Pending/approved intents hold policy budget. Only a committed execution converts that allowance to spent budget and posts money; rejected/expired/revoked requests release unspent holds.

## Checkout Binding

### Merchant-Signed Quotes

An intent may additionally supply `merchantQuoteProof: { keyId, signature }`. The merchant signs the canonical bytes defined by `merchantQuoteBytes` with its Ed25519 private key, which stays outside Rail and agent clients. Operators enroll the corresponding recipient-bound public key in `RAIL_MERCHANT_QUOTE_KEYS`; agents cannot submit their own trust keys. A valid quote has `quoteAssurance: configured_merchant_signature`, not a claim of KYC, price fairness, delivery or external settlement.

For recipients present in the registry, every new agent proposal requires a signed checkout, even if the supplied proof or entire checkout is omitted. Approval and fresh execution repeat current trust checks, including for older unsigned intents after enrollment. A `revoked` entry keeps that recipient blocked from unsigned downgrade while denying the revoked key. Retain these entries when revoking; removing every recipient entry intentionally removes the quote requirement and must not be treated as revocation. Human transfer APIs are unchanged and are not merchant-quote-enforced by this slice.

All quote fields, including funding owner audience, fees, expiry and signing key ID, are signed. Proof/key fingerprints are included in v3 intent/retry fingerprints and immutable protected decision/execution records. Signed quote IDs can belong to only one retained intent per recipient, across agents, owners and quote versions. Identical proposal retries reuse that intent; rejected/expired intents still consume the quote ID and need a fresh merchant quote. Financial failure can retry the same original intent without claiming a new quote. This is not global economic-invoice deduplication across different quote IDs.

Receipts retain the public key snapshot and signature. Historical verification checks the signature and protected authority record; it does not imply that the key is still active. Current revocation blocks new approval/execution, not a completed replay or refund. Consistent configuration on every writer, secure operator enrollment/key rotation and least-privilege SQL roles remain deployment gates. There is no merchant onboarding UI, remote quote fetcher or Rail-hosted merchant signing service.

### Unsigned Checkout Compatibility

The optional `checkout` object on `POST /v2/agent/intents` binds a quote reference/version, merchant wallet, subtotal, fees, total, currency, expiry and internal funding wallet. Recipient and currency must match the transfer; funding must be the authenticated owner's wallet. The transfer amount is the total including fees, all paid to the receiver. No separate fee payout or provider instrument exists here.

Every descriptor field is fingerprint-bound and immutable. Changing it requires a new client request and applicable consent. Expiry is enforced using database time, including after financial work; failed execution rolls back money and budget consumption. Completed replay returns the original result rather than treating an expired quote as a new payment. Original decision and execution evidence retain the descriptor. Without a merchant proof, `quoteAssurance: agent_proposed_unverified` is derived by the backend: this is not merchant authentication, pricing validation or user-signature evidence. No caller verification flag is accepted inside checkout. Omitting checkout retains the simple-transfer contract only for recipients not configured in the merchant registry.

Example optional descriptor (the enclosing intent has `receiverWalletId: merchant_wallet`, `amountMinor: 1000`, `currency: INR`; replace the deadline with a future UTC time):

```json
{
  "checkout": {
    "version": 1,
    "merchantWalletId": "merchant_wallet",
    "quoteId": "quote_001",
    "quoteVersion": 1,
    "subtotalMinor": 950,
    "feeMinor": 50,
    "totalMinor": 1000,
    "currency": "INR",
    "expiresAt": "2026-10-12T12:00:00.000Z",
    "fundingSource": { "type": "internal_wallet", "walletId": "owner_wallet" }
  }
}
```

`quoteId` is an opaque nonsecret reference, not a credential or a place for customer details. Checkout metadata remains relational plaintext even though decision/execution evidence is encrypted. Existing authenticated owner/agent listing boundaries apply; there is no new public quote endpoint.

## Restriction-Bypass Defenses

| Attempt | Implemented defense | Remaining boundary |
| --- | --- | --- |
| Agent calls owner-management or approval routes | JWT-only owner resolution, wallet ownership checks and scoped agent credentials | Theft of a valid owner session requires isolation/step-up controls |
| Promote a proposal credential or extend its lifetime through an ordinary SQL update | Credential identity, token hash, scope and issuance/lifetime fields are immutable | Database owners can disable triggers; agents must have no SQL access |
| Change mandate limits, recipients or approval mode after consent | Immutable policy fields; changes require a new mandate created through owner authority | Direct malicious inserts by a compromised trusted writer are not prevented by these update guards |
| Restore a revoked agent, credential or mandate | Permanent revocation with preserved timestamp and identity history | Revocation blocks subsequent authorized work, not a payment committed earlier |
| Split or concurrently submit transfers beyond the total budget | Locked mandate headroom and deferred intent/budget consistency checks | Recipients and budgets must still be chosen sensibly by the owner |
| Lose the response and retry spending | Fingerprint-bound durable replay and one atomic execution transaction | Hosted failure/load acceptance still needs verification |
| Delete or rewrite authority history | Database update/delete guards and transactional control events | Administrators/DDL remain trusted; no independent checkpoint is live |
| Claim a low ML risk score means permission | Model output has no spending authority | Real-data validation and enforced step-up policy remain future work |

The new database guards do not replace authentication. Mutable reserved/spent counters remain subject to existing financial and deferred consistency guards. Name and identity metadata are also fixed; create a replacement identity when needed rather than rewriting its history. Repeat revocation remains supported.

## Owner Transparency Today

New executions additionally write protected `server_observed_authority` snapshots atomically with money and replay. They bind immutable mandate policy, exact intent/payment fingerprints, executing credential, amount/receiver and execution time. Owner-JWT-only `GET /v2/agents/:agentId/intents/:intentId/authority` returns a verified explanation or explicit pending/legacy/unavailable state; no tokens or keys are disclosed. A separate independent authority ring enables agent spending. Receipt failure rolls back execution; replay verifies the original record and encrypts nothing new. Existing unexecuted legacy intents need replacement rather than invented receipts.

Original protected mandate-consent and effective approve/reject records are now captured with their owner authentication context. HTTP context is verified user-JWT identity/credential version; internal callers are explicitly `trusted_library`. Execution verifies these original records and binds their commitments, without inventing a per-payment decision for budgeted grants. Repeated approvals preserve the first record; later rejection retains approval history while preventing execution. These are backend attestations, not user signatures. Stronger owner authentication, full terminal bindings and authority-inclusive Merkle leaves remain open. No hosted sandbox, distributed fair queue or blockchain publication is claimed.

Owner APIs expose agent status, credential metadata without tokens, mandate recipients/limits/expiry, reserved/spent allowance and intent state/fingerprint. Transaction participants can inspect authenticated payment evidence, protected risk summaries and locally verified Merkle inclusion proofs. Wallet events are scoped to the authenticated wallet; delivery is durable through the outbox, but client notifications need an application/worker integration.

An inclusion proof is not proof of consent. Current leaves bind protected payment and risk records, not the entire mandate policy or independently authenticated approval provenance. Do not describe current roots as blockchain-verified control of a user's transactions.

## Next Implementation Stages

| Stage | Deliverable | Acceptance condition |
| --- | --- | --- |
| 1: Authority hardening | Immutable policies, permanent revocation and ordinary-SQL abuse regression tests | Existing human, offline, concurrency and agent execution tests remain passing |
| 2: Explainable authority receipts | Versioned canonical policy snapshot and exact decision/execution provenance, protected with dedicated purpose bindings in the financial transaction | Tampering, cross-owner substitution, missing authority evidence and replay cannot yield a verified receipt; expose no secret tokens |
| 3: Independent audit anchoring | Commit authority receipts into privacy-preserving batches; publish roots through a separate testnet worker | No personal data/raw wallet IDs on-chain; signer separation, retries, confirmation/reorg recovery and independent verification tests pass |
| 4: Owner control panel and SDK | Explicit preapproval consent, intent review, revoke controls, budget/history and understandable evidence statuses | Human/agent end-to-end tests demonstrate both approval modes; pending/unanchored must never appear settled/final |
| 5: Production trust and integration | Stronger owner step-up, least-privilege database roles, managed key custody, backup recovery and payment-provider sandbox | Independent deployment/security review and settlement reconciliation; never infer production readiness from fixtures |

Stage 2's backend-attested consent/decision/execution records are locally implemented; independent user verification and complete terminal contracts remain open. Stages 3-5 remain planned. Choose the anchor network and signer custody before deployment; do not add on-chain fund movement to this stage. Blockchain can make published evidence independently checkable; it cannot determine truthful original inputs, fix stolen owner credentials or stop a compromised backend before a transfer.

## Verification

The agent regression suite includes direct SQL attempts to rewrite identity, promote credentials, extend deadlines, change policy, clear/rewrite revocation and delete authority history. It also checks repeat migrations, repeat revocation, cross-owner isolation, exact approval, concurrent replay, wallet/budget rollback and deadlines expiring during financial work. Existing GitHub Actions runs this file explicitly on Node 22/24 with PostgreSQL 16.

This document is a threat-model and implementation record, not a zero-vulnerability claim or production certification.
