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

## Acknowledgement Has Two Explicit Modes

1. `approval_required`: the owner approves the exact immutable request fingerprint. Changed recipients, amounts or currencies cannot reuse that approval.
2. `budgeted`: the owner gives advance permission for fixed recipients, currency, per-payment amount, total budget and expiry. The agent does not need another owner click for each in-policy payment. Users must understand this when creating the mandate.

Neither mode permits approvals to override policy or insufficient funds. Pending/approved intents hold policy budget. Only a committed execution converts that allowance to spent budget and posts money; rejected/expired/revoked requests release unspent holds.

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

Stages 2-5 are plans, not implemented capabilities. Choose the anchor network and signer custody before deployment; do not add on-chain fund movement to this stage. Blockchain can make published evidence independently checkable; it cannot determine truthful original inputs, fix stolen owner credentials or stop a compromised backend before a transfer.

## Verification

The agent regression suite includes direct SQL attempts to rewrite identity, promote credentials, extend deadlines, change policy, clear/rewrite revocation and delete authority history. It also checks repeat migrations, repeat revocation, cross-owner isolation, exact approval, concurrent replay, wallet/budget rollback and deadlines expiring during financial work. Existing GitHub Actions runs this file explicitly on Node 22/24 with PostgreSQL 16.

This document is a threat-model and implementation record, not a zero-vulnerability claim or production certification.
