import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { AgentClient, AgentClientError } from "../dist/rail/agentClient.js";
import { agentKeyThumbprint, verifyAgentProof } from "../dist/crypto/agentProof.js";

async function fixture(work, override) {
  const pair = generateKeyPairSync("ed25519"), token = `rail_agent_${randomBytes(32).toString("base64url")}`;
  const keyThumbprint = agentKeyThumbprint(pair.publicKey.export({ format: "jwk" }));
  const calls = [], nonces = new Set();
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      assert.equal(req.headers.authorization, `DPoP ${token}`);
      if (override && await override(req, res, { raw, calls })) return;
      if (req.url === "/v2/agent/nonces") {
        assert.equal(req.method, "POST"); assert.equal(raw.toString(), "{}"); assert.equal(req.headers.dpop, undefined);
        const nonce = randomBytes(32).toString("base64url"); nonces.add(nonce);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ nonce })); return;
      }
      const claims = JSON.parse(Buffer.from(req.headers.dpop.split(".")[1], "base64url").toString());
      assert.equal(nonces.delete(claims.nonce), true);
      const proof = verifyAgentProof(req.headers.dpop, { method: req.method, url: `${origin}${req.url}`, accessToken: token,
        body: raw, nonce: claims.nonce, keyThumbprint, nowSeconds: Math.floor(Date.now() / 1000) });
      calls.push({ path: req.url, method: req.method, body: raw.length ? JSON.parse(raw) : undefined, proof });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/v2/agent/identity") res.end(JSON.stringify({ identity: { agentId: "test_fixture_agent" } }));
      else if (req.method === "GET") res.end(JSON.stringify({ intents: [] }));
      else if (req.url.endsWith("/execute")) res.end(JSON.stringify({ intent: { intentId: "test_fixture_intent" }, result: { status: "accepted", ledgerEntryId: "fixture_replayed" } }));
      else res.end(JSON.stringify({ intent: { intentId: "test_fixture_intent", requestFingerprint: "a".repeat(64) } }));
    } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "fixture_verification_failed" })); }
  });
  server.listen(0); await once(server, "listening"); origin = `http://localhost:${server.address().port}`;
  const client = new AgentClient({ origin, token, privateKey: pair.privateKey, allowLocalHttp: true });
  try { await work({ client, calls, token, pair, origin }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const proposal = () => ({ mandateId: randomUUID(), clientRequestId: randomUUID(), receiverWalletId: "receiver_fixture", amountMinor: 100, currency: "INR" });

test("agent client signs identity, proposals, history and execution with real method/URL/body-bound proofs", async () => {
  await fixture(async ({ client, calls }) => {
    assert.equal((await client.identity()).agentId, "test_fixture_agent");
    assert.deepEqual(await client.listIntents(), []);
    const value = proposal(); await client.proposeIntent(value);
    await client.executeIntent(randomUUID(), "a".repeat(64));
    assert.equal(calls.length, 4); assert.deepEqual(calls[2].body, value);
    assert.equal(new Set(calls.map(call => call.proof.nonce)).size, 4);
    assert.equal(new Set(calls.map(call => call.proof.proofId)).size, 4);
  });
});

test("explicit payment retries retain purchase identity while using a fresh nonce and proof", async () => {
  await fixture(async ({ client, calls }) => {
    const intentId = randomUUID(), fingerprint = "b".repeat(64), value = proposal();
    await client.proposeIntent(value); await client.proposeIntent(value);
    const first = await client.executeIntent(intentId, fingerprint), replay = await client.executeIntent(intentId, fingerprint);
    assert.deepEqual(first, replay);
    assert.deepEqual(calls[0].body, calls[1].body); assert.equal(calls[2].path, calls[3].path);
    assert.deepEqual(calls[2].body, calls[3].body); assert.notEqual(calls[2].proof.proofId, calls[3].proof.proofId);
  });
});

test("agent client keeps credentials private and rejects unsafe origins, keys and execution targets", async () => {
  await fixture(async ({ client, token, pair }) => {
    assert.equal(JSON.stringify(client), "{}"); assert.equal(inspect(client).includes(token), false);
    for (const origin of ["http://example.com", "https://example.com/", "https://example.com/path", "https://user:secret@example.com", "https://example.com?query=1"])
      assert.throws(() => new AgentClient({ origin, token, privateKey: pair.privateKey }), /INVALID_AGENT_CLIENT_ORIGIN/);
    assert.throws(() => new AgentClient({ origin: "https://example.com", token, privateKey: pair.publicKey }), /INVALID_AGENT_CLIENT_CONFIGURATION/);
    await assert.rejects(client.executeIntent("../other_agent", "a".repeat(64)), { code: "invalid_agent_execution_request" });
    await assert.rejects(client.executeIntent(randomUUID(), "not_a_fingerprint"), { code: "invalid_agent_execution_request" });
  });
});

test("rate-limit responses expose bounded retry metadata without automatic payment retries", async () => {
  let requests = 0;
  await fixture(async ({ client }) => {
    await assert.rejects(client.proposeIntent(proposal()), error => error instanceof AgentClientError && error.status === 429 && error.code === "rate_limited" && error.retryAfterSeconds === 60);
    assert.equal(requests, 1);
  }, async (req, res) => { requests++; res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" }); res.end('{"error":"rate_limited"}'); return true; });
});

test("agent client refuses redirects rather than forwarding credentials", async () => {
  let requests = 0;
  await fixture(async ({ client }) => {
    await assert.rejects(client.identity(), { code: "agent_network_error" }); assert.equal(requests, 1);
  }, async (req, res) => { requests++; res.writeHead(302, { Location: "/other_destination" }); res.end(); return true; });
});

test("malformed or oversized responses and oversized requests fail without exposing response contents", async () => {
  for (const raw of ["not_json_secret_fixture", JSON.stringify({ nonce: "x".repeat(70000) }), "[]"]) await fixture(async ({ client }) => {
    await assert.rejects(client.identity(), error => error.code === "invalid_agent_response" && !error.message.includes(raw));
  }, async (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(raw); return true; });
  await fixture(async ({ client, calls }) => {
    await assert.rejects(client.proposeIntent({ ...proposal(), unexpected: "x".repeat(70000) }), { code: "agent_request_too_large" });
    assert.equal(calls.length, 0);
  });
});

test("agent request bytes are snapshotted before awaiting a nonce", async () => {
  let release, received;
  const nonceRequested = new Promise(resolve => { received = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  await fixture(async ({ client, calls }) => {
    const value = proposal(), operation = client.proposeIntent(value);
    await nonceRequested; value.amountMinor = 999; release();
    await operation; assert.equal(calls[0].body.amountMinor, 100);
  }, async (req) => { if (req.url === "/v2/agent/nonces") { received(); await proceed; } return false; });
});
