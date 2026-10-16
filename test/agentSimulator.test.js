import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulatorConfiguration, simulatorPrivateKey, runAgentSimulation } from "../dist/demo/runAgentSimulator.js";

const environment = () => ({ NODE_ENV: "test", RAIL_DEMO_MODE: "true", RAIL_AGENT_ORIGIN: "http://localhost:3000",
  RAIL_AGENT_TOKEN: `rail_agent_${randomBytes(32).toString("base64url")}`, RAIL_AGENT_PRIVATE_KEY_PATH: "/not-read-by-config.pem",
  RAIL_AGENT_MANDATE_ID: randomUUID(), RAIL_AGENT_REQUEST_ID: "demo_run_001_agent_one", RAIL_AGENT_RECEIVER_WALLET_ID: "demo_receiver",
  RAIL_AGENT_AMOUNT_MINOR: "650000", RAIL_AGENT_CURRENCY: "INR" });

test("simulators require explicit non-production local configuration and stable request identities", () => {
  const env = environment(), config = simulatorConfiguration(env, "propose");
  assert.equal(config.request.amountMinor, 650000); assert.equal(config.request.clientRequestId, env.RAIL_AGENT_REQUEST_ID);
  assert.equal(config.request.ttlSeconds, 300);
  assert.deepEqual(simulatorConfiguration(env, "execute").request, config.request); assert.ok(Object.isFrozen(config.request));
  for (const patch of [{ NODE_ENV: "production" }, { RAIL_DEMO_MODE: "false" }, { RAIL_AGENT_ORIGIN: "https://example.com" },
    { RAIL_AGENT_ORIGIN: "http://user:secret@localhost:3000" }, { RAIL_AGENT_ORIGIN: "http://localhost:3000/path" },
    { RAIL_AGENT_AMOUNT_MINOR: "1.5" }, { RAIL_AGENT_AMOUNT_MINOR: "0" }, { RAIL_AGENT_AMOUNT_MINOR: "1000000000001" },
    { RAIL_AGENT_REQUEST_ID: "" }, { RAIL_AGENT_CURRENCY: "inr" }, { RAIL_AGENT_MANDATE_ID: "../other" }])
    assert.throws(() => simulatorConfiguration({ ...env, ...patch }, "propose"));
  assert.throws(() => simulatorConfiguration(env, "approve"));
});

test("simulator proposals do not automatically execute and emit only allowlisted fields", async () => {
  const request = simulatorConfiguration(environment(), "propose").request;
  const result = await runAgentSimulation({ proposeIntent: async value => {
    assert.deepEqual(value, request); return { ...request, intentId: randomUUID(), requestFingerprint: "a".repeat(64), status: "pending", privateFixture: "not_to_be_printed" };
  }, executeIntent: () => assert.fail("must not execute") }, "propose", request);
  assert.equal(result.status, "pending"); assert.equal(JSON.stringify(result).includes("not_to_be_printed"), false);
  assert.equal(result.clientRequestId, undefined);
});

test("status after an uncertain response does not create a new proposal or payment", async () => {
  const request = simulatorConfiguration(environment(), "status").request;
  const client = { listIntents: async () => [], proposeIntent: () => assert.fail("no re-proposal"), executeIntent: () => assert.fail("no payment") };
  assert.deepEqual(await runAgentSimulation(client, "status", request), { status: "not_found" });
  await assert.rejects(runAgentSimulation(client, "execute", request), /simulator_intent_not_found/);
});

test("simulators refuse changed terms, duplicate identities and unapproved intents before execution", async () => {
  const request = simulatorConfiguration(environment(), "execute").request;
  const original = { ...request, intentId: randomUUID(), requestFingerprint: "a".repeat(64), status: "approved" };
  for (const patch of [{ mandateId: randomUUID() }, { amountMinor: 1 }, { currency: "USD" }, { receiverWalletId: "other_receiver" }])
    await assert.rejects(runAgentSimulation({ listIntents: async () => [{ ...original, ...patch }], executeIntent: () => assert.fail("changed terms") }, "execute", request), /simulator_terms_mismatch/);
  await assert.rejects(runAgentSimulation({ listIntents: async () => [original, original] }, "execute", request), /simulator_terms_mismatch/);
  for (const status of ["pending", "rejected", "expired"])
    await assert.rejects(runAgentSimulation({ listIntents: async () => [{ ...original, status }] }, "execute", request), /simulator_owner_approval_required/);
});

test("explicit simulator execution and replay keep the original intent and fingerprint", async () => {
  const request = simulatorConfiguration(environment(), "execute").request, calls = [];
  const intent = { ...request, intentId: randomUUID(), requestFingerprint: "b".repeat(64), status: "approved" };
  const client = { listIntents: async () => [intent], executeIntent: async (...args) => { calls.push(args); intent.status = "executed"; return { intent }; } };
  await runAgentSimulation(client, "execute", request); await runAgentSimulation(client, "execute", request);
  assert.deepEqual(calls, [[intent.intentId, intent.requestFingerprint], [intent.intentId, intent.requestFingerprint]]);
});

test("simulator key loading rejects public permissions, symlinks, directories and oversized files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rail-simulator-")), path = join(dir, "key.pem");
  const key = generateKeyPairSync("ed25519").privateKey;
  try {
    await writeFile(path, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    assert.equal(simulatorPrivateKey(path).asymmetricKeyType, "ed25519");
    if (process.platform !== "win32") {
      await chmod(path, 0o644); assert.throws(() => simulatorPrivateKey(path), /unsafe_simulator_key_file/); await chmod(path, 0o600);
      const link = join(dir, "link.pem"); await symlink(path, link); assert.throws(() => simulatorPrivateKey(link));
    }
    assert.throws(() => simulatorPrivateKey(dir));
    await writeFile(path, "x".repeat(4097)); assert.throws(() => simulatorPrivateKey(path), /unsafe_simulator_key_file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
