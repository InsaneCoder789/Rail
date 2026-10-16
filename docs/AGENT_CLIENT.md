# Narrow Node.js Agent Client

## What It Does

`src/rail/agentClient.ts` is a small helper for external agent processes. It supports
identity, proposal, own-intent history and exact execution through Rail's existing
proof-enabled API. It is not an owner SDK, hosted-agent runtime, published package
or payment-provider integration.

An owner must first approve the agent's public key and credential scope. The agent
process receives only its own scoped token, matching Ed25519 private key, API origin
and permitted mandate references. Never copy Rail's full server `.env`, owner JWTs,
recovery codes, database secrets or provider credentials into an agent environment.
Private-key storage/custody remains an operator responsibility, not something this
helper solves by keeping its fields private in memory.

## Request Sequence

For each call, the helper snapshots JSON bytes before awaiting anything, obtains a
new server nonce and signs a new DPoP proof. The signature binds the access-token
hash, exact method/URL, nonce, fresh proof ID and exact body digest. GET requests
bind an empty body. The matching owner-approved key is required by the backend.

HTTPS is required. Localhost HTTP requires explicit `allowLocalHttp: true` and is
refused in production. Redirects are rejected rather than forwarding credentials.
Requests/responses are bounded to 64 KiB and network exchanges have a bounded timeout.
The helper is Node.js-specific; it does not put signing keys into browser storage.

## Usage

After building, the following illustrates an agent-only process using an existing
owner-approved credential and mandate. Keep these environment values separate from
the backend's configuration. Protect the private-key file and never commit it.

```js
import { createPrivateKey, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AgentClient } from "./dist/rail/agentClient.js";

const required = name => {
  if (!process.env[name]) throw new Error(`Missing agent configuration: ${name}`);
  return process.env[name];
};
const client = new AgentClient({
  origin: required("RAIL_AGENT_ORIGIN"),
  token: required("RAIL_AGENT_TOKEN"),
  privateKey: createPrivateKey(readFileSync(required("RAIL_AGENT_PRIVATE_KEY_PATH"))),
});
const request = {
  mandateId: required("RAIL_AGENT_MANDATE_ID"),
  clientRequestId: randomUUID(),
  receiverWalletId: required("RAIL_AGENT_RECEIVER_WALLET_ID"),
  amountMinor: 100,
  currency: "INR",
};
const intent = await client.proposeIntent(request);
if (intent.status === "approved") {
  await client.executeIntent(intent.intentId, intent.requestFingerprint);
}
```

Do not blindly rerun this example as retry logic: it creates a new request ID each
run. Real agent jobs must persist their proposal ID and returned intent/fingerprint
before attempting repeat execution. For `approval_required`, wait for the owner to
approve through the owner interface; an agent cannot approve its own request.

## Retry And Error Rules

There are no automatic payment retries. `AgentClientError` exposes a bounded code,
HTTP status and optional `retryAfterSeconds`. Network errors use status zero and
`agent_network_error`; they do not prove a payment failed. Malformed responses are
also not proof that execution rolled back. Inspect original intent state before
deciding what to do next.

Explicit proposal retries reuse the original `clientRequestId` and identical terms.
Explicit execution retries reuse the original intent ID and fingerprint. Each call
still obtains a fresh nonce/proof. A new proof does not mean a new financial request.
Respect quota backoff; do not parallelize retries to evade a `429` response.

## Verification And Remaining Work

Seven protocol tests cover real signatures, retries, private-field hygiene, unsafe
targets, redirects, quotas, bounded/malformed data and mutation during nonce waits.
A separate real HTTP/PostgreSQL test enrolls three distinct agent keys with signed
owner consent, races requests against one shared budget, denies cross-agent execution
and verifies only permitted internal ledger effects. That is not an external provider
test. The [standalone simulator executable](./AGENT_SIMULATORS.md) and
[owner console](./OWNER_CONSOLE.md) now exist. The console has focused native browser
acceptance; the updated three-process/lost-reply integration case awaits a fresh
run. External provider timeout/reconciliation remains C2 work; this client alone
does not complete C3.
