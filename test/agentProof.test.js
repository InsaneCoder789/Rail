import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { Point } from "@noble/ed25519";
import { agentBodyDigest, agentKeyThumbprint, parseAgentPublicKey, verifyAgentProof } from "../dist/crypto/agentProof.js";

const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const random = () => randomBytes(32).toString("base64url");
const body = Buffer.from('{"amountMinor":100}');
const request = { method: "POST", url: "https://rail.example/v2/agent/intents", accessToken: `rail_agent_${random()}`,
  body, nonce: random(), keyThumbprint: agentKeyThumbprint(jwk), nowSeconds: 1_800_000_000 };
function signed(changes = {}, headerChanges = {}, key = pair.privateKey) {
  const header = { typ: "dpop+jwt", alg: "EdDSA", jwk, ...headerChanges };
  const claims = { htm: request.method, htu: request.url, iat: request.nowSeconds, jti: random(),
    ath: createHash("sha256").update(request.accessToken).digest("base64url"), nonce: request.nonce,
    rail_body_sha256: agentBodyDigest(body), ...changes };
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}
const deny = work => assert.throws(work, { status: 401, code: "invalid_agent_proof" });

test("agent keys reject identity, small-order, mixed-order and noncanonical public points", t => {
  const identity = Buffer.alloc(32); identity[0] = 1;
  const weak = { kty: "OKP", crv: "Ed25519", x: identity.toString("base64url") };
  const forged = Buffer.alloc(64); forged[0] = 1;
  const message = Buffer.from("rail-weak-key-regression");
  if (verify(null, message, createPublicKey({ key: weak, format: "jwk" }), forged))
    t.diagnostic("native verifier accepts the degenerate-key forgery; Rail must reject that public key");
  const torsion = Point.fromBytes(Buffer.alloc(32), false);
  const mixed = Point.BASE.add(torsion).toBytes();
  for (const bytes of [identity, Buffer.alloc(32), mixed, Buffer.alloc(32, 255)])
    deny(() => parseAgentPublicKey({ ...weak, x: Buffer.from(bytes).toString("base64url") }));
  const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: weak };
  const claims = { htm: request.method, htu: request.url, iat: request.nowSeconds, jti: random(), nonce: request.nonce,
    ath: createHash("sha256").update(request.accessToken).digest("base64url"), rail_body_sha256: agentBodyDigest(body) };
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  const thumbprint = createHash("sha256").update(JSON.stringify({ crv: weak.crv, kty: weak.kty, x: weak.x })).digest("base64url");
  deny(() => verifyAgentProof(`${input}.${forged.toString("base64url")}`, { ...request, keyThumbprint: thumbprint }));
});

test("agent DPoP validates real Ed25519 signatures and stable RFC 7638 key binding", () => {
  const result = verifyAgentProof(signed(), request);
  assert.equal(result.keyThumbprint, request.keyThumbprint);
  assert.equal(result.validUntil, request.nowSeconds + 30);
  assert.equal(result.bodyDigest, agentBodyDigest(body));
  assert.ok(Object.isFrozen(result));
  assert.equal(agentKeyThumbprint({ x: jwk.x, crv: jwk.crv, kty: jwk.kty }), request.keyThumbprint);
  assert.deepEqual(parseAgentPublicKey(jwk), jwk);
});

test("agent proof binds method, origin, path, nonce, access token and exact body bytes", () => {
  const proof = signed();
  for (const change of [{ method: "GET", body: Buffer.alloc(0) }, { url: "https://other.example/v2/agent/intents" },
    { url: `${request.url}/other` }, { nonce: random() }, { accessToken: `rail_agent_${random()}` },
    { body: Buffer.from('{"amountMinor":101}') }, { body: Buffer.from('{ "amountMinor":100}') }, { keyThumbprint: random() }]) {
    deny(() => verifyAgentProof(proof, { ...request, ...change }));
  }
});

test("agent proof rejects future, stale, fractional and malformed claims", () => {
  for (const change of [{ iat: request.nowSeconds + 1 }, { iat: request.nowSeconds - 31 }, { iat: -1 },
    { iat: 1.5 }, { iat: "1800000000" }, { jti: "short" }, { nonce: "short" }, { htm: "post" },
    { ath: "bad" }, { rail_body_sha256: "bad" }, { extra: true }]) deny(() => verifyAgentProof(signed(change), request));
  assert.equal(verifyAgentProof(signed({ iat: request.nowSeconds - 30 }), request).issuedAt, request.nowSeconds - 30);
});

test("agent proof refuses private keys, algorithm confusion and attacker signing keys", () => {
  const other = generateKeyPairSync("ed25519");
  for (const change of [{ alg: "none" }, { alg: "HS256" }, { typ: "JWT" }, { kid: "ignored" },
    { jwk: pair.privateKey.export({ format: "jwk" }) }, { jwk: { ...jwk, crv: "X25519" } },
    { jwk: { ...jwk, x: `${jwk.x}=` } }, { jwk: { ...jwk, x: "AA" } },
    { jwk: other.publicKey.export({ format: "jwk" }) }]) deny(() => verifyAgentProof(signed({}, change), request));
  deny(() => verifyAgentProof(signed({}, {}, other.privateKey), request));
});

test("agent proof rejects malformed encodings, altered signatures and unbounded inputs", () => {
  const proof = signed();
  for (const value of [null, {}, "", "x".repeat(8193), `${proof}.extra`, proof.replace(".", "=."),
    `${proof.slice(0, proof.lastIndexOf('.') + 1)}${randomBytes(64).toString("base64url")}`]) deny(() => verifyAgentProof(value, request));
  for (const change of [{ url: `${request.url}?amount=1` }, { url: `${request.url}#fragment` },
    { url: "http://rail.example/v2/agent/intents" }, { url: "https://user:password@rail.example/v2/agent/intents" },
    { nowSeconds: NaN }, { nowSeconds: -1 }, { method: "PUT" }, { body: "not bytes" }]) deny(() => verifyAgentProof(proof, { ...request, ...change }));
});

test("agent GET proof binds an empty body; crypto verification alone does not consume a nonce", () => {
  const proof = signed({ htm: "GET", rail_body_sha256: agentBodyDigest(Buffer.alloc(0)) });
  const get = { ...request, method: "GET", body: Buffer.alloc(0) };
  const first = verifyAgentProof(proof, get);
  assert.deepEqual(verifyAgentProof(proof, get), first);
  deny(() => verifyAgentProof(proof, { ...get, body }));
});
