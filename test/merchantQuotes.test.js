import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { MerchantQuoteRegistry, merchantQuoteBytes, parseMerchantQuoteProof, verifyMerchantAttestation } from "../dist/crypto/merchantQuotes.js";

const pair = generateKeyPairSync("ed25519");
const entry = { keyId: "merchant_key_001", merchantWalletId: "merchant_wallet", status: "active",
  publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
const checkout = { version: 1, merchantWalletId: "merchant_wallet", quoteId: "quote_001", quoteVersion: 1,
  subtotalMinor: 90, feeMinor: 10, totalMinor: 100, currency: "INR", expiresAt: "2026-12-01T00:00:00.000Z",
  fundingSource: { type: "internal_wallet", walletId: "owner_wallet" } };
const proof = { keyId: entry.keyId, signature: sign(null, merchantQuoteBytes(checkout, entry.keyId), pair.privateKey).toString("base64") };

test("merchant signature binds every checkout field, audience and signing key ID", () => {
  const registry = new MerchantQuoteRegistry(JSON.stringify([entry]));
  const attestation = registry.authenticate(checkout, proof);
  assert.equal(attestation.publicKey, entry.publicKey);
  verifyMerchantAttestation(checkout, attestation);
  registry.requireCurrent(checkout, attestation);
  for (const change of [{ version: 2 }, { merchantWalletId: "another_wallet" }, { quoteId: "quote_002" },
    { quoteVersion: 2 }, { subtotalMinor: 80 }, { feeMinor: 20 }, { totalMinor: 101 }, { currency: "USD" },
    { expiresAt: "2026-12-02T00:00:00.000Z" }, { fundingSource: { type: "internal_wallet", walletId: "another_owner" } },
    { fundingSource: { type: "card", walletId: "owner_wallet" } }]) {
    assert.throws(() => registry.authenticate({ ...checkout, ...change }, proof), { code: "merchant_quote_denied" });
  }
  assert.throws(() => registry.authenticate(checkout, { ...proof, keyId: "another_key" }), { code: "merchant_quote_denied" });
});

test("merchant registry fails closed for malformed, duplicate, private and wrong-algorithm keys", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  for (const value of ["not_json", " ", "[]", "{}", "x".repeat(65537), JSON.stringify([entry, entry]),
    JSON.stringify([{ ...entry, publicKey: "invalid" }]), JSON.stringify([{ ...entry, verified: true }]),
    JSON.stringify([{ ...entry, status: "unknown" }]), JSON.stringify([{ ...entry, publicKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") }]),
    JSON.stringify([{ ...entry, publicKey: ec.publicKey.export({ type: "spki", format: "der" }).toString("base64") }]),
    JSON.stringify([entry, { ...entry, keyId: "same_material_alias" }])]) {
    assert.throws(() => new MerchantQuoteRegistry(value), { message: "INVALID_MERCHANT_QUOTE_KEYS" });
  }
  assert.throws(() => new MerchantQuoteRegistry().authenticate(checkout, proof), { code: "merchant_quote_denied" });
});

test("revoked recipient keys require proofs but cannot authorize fresh work", () => {
  const revoked = new MerchantQuoteRegistry(JSON.stringify([{ ...entry, status: "revoked" }]));
  assert.equal(revoked.requiresProof(entry.merchantWalletId), true);
  assert.equal(revoked.requiresProof("different_wallet"), false);
  assert.throws(() => revoked.authenticate(checkout, proof), { code: "merchant_quote_denied" });
  const original = new MerchantQuoteRegistry(JSON.stringify([entry])).authenticate(checkout, proof);
  assert.doesNotThrow(() => verifyMerchantAttestation(checkout, original));
  assert.throws(() => revoked.requireCurrent(checkout, original), { code: "merchant_quote_denied" });
  const replacement = generateKeyPairSync("ed25519");
  const changed = new MerchantQuoteRegistry(JSON.stringify([{ ...entry,
    publicKey: replacement.publicKey.export({ type: "spki", format: "der" }).toString("base64") }]));
  assert.throws(() => changed.requireCurrent(checkout, original), { code: "merchant_quote_denied" });
});

test("stored merchant evidence rejects substituted key material, metadata and signatures", () => {
  const attestation = new MerchantQuoteRegistry(JSON.stringify([entry])).authenticate(checkout, proof);
  const other = generateKeyPairSync("ed25519");
  for (const change of [{ version: 2 }, { keyFingerprint: "0".repeat(64) }, { publicKey: other.publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    { signature: Buffer.alloc(64).toString("base64") }, { verified: true }, { keyId: "substituted_key" }])
    assert.throws(() => verifyMerchantAttestation(checkout, { ...attestation, ...change }), /merchant_quote_attestation_invalid/);
});

test("proof parsing bounds work and copies caller values without accepting verification claims", () => {
  const mutable = { ...proof }, parsed = parseMerchantQuoteProof(mutable);
  mutable.keyId = "changed_key";
  assert.deepEqual(parsed, proof);
  assert.ok(Object.isFrozen(parsed));
  for (const value of [null, [], { ...proof, publicKey: entry.publicKey }, { ...proof, verified: true },
    { ...proof, signature: "a".repeat(100000) }, { ...proof, signature: proof.signature.replace(/=$/, "") },
    { ...proof, signature: "!".repeat(88) }, { ...proof, keyId: "x" }])
    assert.throws(() => parseMerchantQuoteProof(value), { status: 422 });
});
