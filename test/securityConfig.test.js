import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { loadServerConfig } from "../dist/server/config.js";
import { generateToken, verifyToken } from "../dist/auth/jwt.js";
import { createAuthResolver } from "../dist/server/authentication.js";

function withEnvironment(values, work) {
  const original = {};
  for (const [name, value] of Object.entries(values)) {
    original[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  return Promise.resolve().then(work).finally(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test("serverless runtime does not implicitly trust client proxy headers", () => withEnvironment({
  NODE_ENV: "test", VERCEL: "1", RAIL_TRUST_PROXY_HEADERS: undefined,
}, () => {
  assert.equal(loadServerConfig().trustProxyHeaders, false);
  process.env.RAIL_TRUST_PROXY_HEADERS = "true";
  assert.equal(loadServerConfig().trustProxyHeaders, true);
}));

test("production startup rejects short service keys", () => withEnvironment({
  NODE_ENV: "production", DATABASE_URL: "postgresql://example.invalid/rail",
  JWT_SECRET: "x".repeat(40), RAIL_SIGNING_SECRET: "y".repeat(40),
  RAIL_ALLOWED_ORIGINS: "https://frontend.example", RAIL_API_KEY: "short",
}, () => {
  assert.throws(loadServerConfig, { message: "PRODUCTION_API_KEY_MUST_BE_AT_LEAST_32_CHARACTERS" });
  process.env.RAIL_API_KEY = "z".repeat(40);
  assert.equal(loadServerConfig().apiKey.length, 40);
}));

test("invalid, expired and non-HS256 JWTs fail with a generic authentication response", () => withEnvironment({
  JWT_SECRET: "jwt_test_secret_012345678901234567890123456789",
}, async () => {
  const options = { issuer: "rail", audience: "rail-clients" };
  const invalid = ["bad_token",
    jwt.sign({ userId: "user_001" }, process.env.JWT_SECRET, { ...options, expiresIn: -1 }),
    jwt.sign({ userId: "user_001" }, process.env.JWT_SECRET, { ...options, algorithm: "HS384" }),
    jwt.sign({ userId: 123 }, process.env.JWT_SECRET, options)];
  const resolver = createAuthResolver({ getPool: () => ({ async query() { return { rowCount: 0 }; } }), apiKey: "", apiKeyScopes: [] });
  for (const token of invalid) {
    await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${token}` } }),
      { status: 401, code: "invalid_credentials" });
  }
  const valid = generateToken("user_001");
  assert.equal(verifyToken(valid).userId, "user_001");
  await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${valid}` } }), { status: 401 });
  await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { "x-rail-api-key": "unknown_key" } }), { status: 401 });
}));
