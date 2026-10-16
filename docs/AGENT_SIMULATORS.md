# Three Independent Agent Simulators

## Purpose

`src/demo/runAgentSimulator.ts` is one reusable executable launched as three
independent external Node.js processes, each with a different owner-approved
agent token, Ed25519 private key and mandate. It calls HTTP routes; it does not
import the database, payment engine, owner session or provider credentials.
This is an internal-wallet demonstration, not a provider sandbox or AI model.

The executable requires explicit non-production `RAIL_DEMO_MODE=true` and an exact
`http://localhost:<port>` origin. It cannot run against a hosted or live service.
Use an isolated demo database. The executable never creates wallets, users,
credentials, shared budgets or mandates. Configure these through the existing
owner/passkey APIs before starting the agent processes.

## Per-Agent Configuration

Give each process only these environment variables; do not pass the server's
`.env` or inherit owner/database/provider credentials. A local operator may use
three private environment files outside the repository, with restricted permissions.
Never place actual keys or tokens in these docs or command arguments.

```dotenv
NODE_ENV=development
RAIL_DEMO_MODE=true
RAIL_AGENT_ORIGIN=http://localhost:3000
RAIL_AGENT_TOKEN=<this-agent-only-scoped-token>
RAIL_AGENT_PRIVATE_KEY_PATH=<this-agent-only-private-pem-path>
RAIL_AGENT_MANDATE_ID=<this-agent-owner-approved-mandate-uuid>
RAIL_AGENT_REQUEST_ID=demo_20261015_study_001
RAIL_AGENT_RECEIVER_WALLET_ID=demo_receiver
RAIL_AGENT_AMOUNT_MINOR=650000
RAIL_AGENT_CURRENCY=INR
```

The key must be a small regular file. On POSIX, the executable rejects symlinks,
group/world access and keys owned by a different user. Use `0600` or `0400`.
On Windows, secure NTFS ACLs are an operator responsibility; POSIX mode checking
does not establish Windows custody. This is not hardware-backed key storage.

Build once with `npm run build`. For an operator-created, private environment file,
start each process from a clean environment (Node 22 or 24):

```sh
NODE_BIN="$(command -v node)"
env -i "$NODE_BIN" --env-file=/private/path/study.env dist/demo/runAgentSimulator.js propose
env -i "$NODE_BIN" --env-file=/private/path/tools.env dist/demo/runAgentSimulator.js propose
env -i "$NODE_BIN" --env-file=/private/path/travel.env dist/demo/runAgentSimulator.js propose
```

Those commands are sequential for inspection; launch the three `propose` commands
concurrently to demonstrate database admission races. Different process boundaries
are not an OS sandbox: agents with the same OS user can still access that user's
files. Rail's actual isolation boundary is scoped credentials and server-side
authorization, not a promise that local processes are mutually inaccessible.

## Reproducible Scenarios

Create one INR shared budget of `1000000` minor units and three budgeted mandates
bound to it. Use `650000`, `350000` and `250000` minor-unit requests with distinct
stable request IDs. All three cannot reserve together; the database admits only
valid available allowance. No specific winner or fairness ordering is promised.
An admitted subset is not necessarily all the available balance.

`propose` only creates or replays a proposal. It never automatically executes.
New proposals use a fixed 300-second intent lifetime, within the API's 60-900-second
contract. That lifetime differs from the longer-lived owner mandate; the mandate
cannot extend an individual payment's expiry.
`status` reads the original request from that agent's own intent history and never
creates missing work. `execute` first checks the original mandate, recipient,
amount and currency, then submits the exact stored intent/fingerprint only if
approved or already executed. Every HTTP call obtains a fresh DPoP proof.

Run `status` or `execute` by replacing only the final command word; keep all original
request environment values. Never generate a new request ID because a response
was lost. A network error or malformed response is an unknown outcome, not proof
of rollback. Inspect `status`; an explicit replay of the original executed intent
uses existing backend idempotency. No automatic retry/backoff loop runs here.

For an `approval_required` mandate, inspect the proposal in `/demo/owner` and approve
with the owner's passkey. `execute` refuses pending, expired or rejected intents;
approval cannot bypass live budget, recipient, expiry or credential checks. Agent
processes never receive the owner's session or approve their own exceptions.

Only allowlisted intent summary fields are printed. CLI failures expose bounded
codes, not raw provider bodies, keys or access tokens. HTTP rejection exits `2`;
configuration/local failures exit `1`. Successful `status: not_found` does not
authorize replacement work. Request/response size and network timeouts come from
the narrow agent client. Own-intent history currently has no cursor pagination;
an oversized history fails closed rather than silently selecting another payment.

## Verification And Remaining Gates

Six unit tests cover configuration gates, stable request identities, no automatic
execution/reproposal, mismatched terms, explicit replay and key-file restrictions.
The real HTTP/PostgreSQL acceptance case now launches three distinct simulator
processes concurrently, checks over-budget and cross-agent denial, drops a reply
after an internal transfer commits, inspects its original status and replays it
without duplicate ledger entries. The updated case passed in the direct full
backend regression on 16 October 2026; all three native Chromium journeys also
passed and the disposable database was removed. A dropped internal HTTP reply is not proof of correct external
provider timeout reconciliation. C2's durable worker, verified callbacks and actual
selected-provider sandbox gate remain open.
