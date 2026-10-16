import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleAuthRoutes } from "../dist/server/routes/authRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";
import { SlidingWindowRateLimiter } from "../dist/server/http.js";
import { hash } from "bcryptjs";
import { verifyToken } from "../dist/auth/jwt.js";

test("login returns only the server-bound wallet alongside the owner token", async () => {
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "auth_wallet_fixture_secret_01234567890123456789";
  try {
    const password = "fixture_password";
    const passwordHash = await hash(password, 4);
    const context = { config: loadServerConfig(), rateLimiter: new SlidingWindowRateLimiter(),
      pool: { async query(sql, parameters) {
        assert.match(sql, /wallet_id/); assert.deepEqual(parameters, ["owner_user"]);
        return { rowCount: 1, rows: [{ password_hash: passwordHash, auth_version: 2, wallet_id: "server_bound_wallet" }] };
      } } };
    let body, status;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(raw) { body = JSON.parse(raw); } };
    await handleAuthRoutes(request({ userId: "owner_user", password, walletId: "forged_wallet" }), res, new URL("http://local/auth/login"), context);
    assert.equal(status, 200); assert.equal(body.walletId, "server_bound_wallet");
    assert.deepEqual(verifyToken(body.token), { userId: "owner_user", authVersion: 2 });
    assert.equal(body.password_hash, undefined); assert.equal(body.password, undefined);
  } finally { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});

function request(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

test("authentication routes reject non-object JSON without accessing the database", async () => {
  for (const path of ["/auth/register", "/auth/login"]) {
    for (const body of [null, [], "invalid", 123]) {
      await assert.rejects(handleAuthRoutes(request(body), { setHeader() {} }, new URL(`http://localhost${path}`),
        { config: loadServerConfig(), rateLimiter: new SlidingWindowRateLimiter() }),
        { status: 422, code: "invalid_body" });
    }
  }
});

test("rotating usernames cannot bypass the per-IP login quota", async () => {
  const config = loadServerConfig();
  const context = {
    config: { ...config, rateLimits: { ...config.rateLimits, loginMax: 2 } },
    pool: { async query() { return { rowCount: 0, rows: [] }; } },
    rateLimiter: new SlidingWindowRateLimiter(),
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(handleAuthRoutes(request({ userId: `user_${i}`, password: "password_123" }),
      { setHeader() {} }, new URL("http://localhost/auth/login"), context), { status: 401 });
  }
  await assert.rejects(handleAuthRoutes(request({ userId: "different_user", password: "password_123" }),
    { setHeader() {} }, new URL("http://localhost/auth/login"), context), { status: 429 });
});

test("registration rejects passwords beyond bcrypt's UTF-8 byte limit", async () => {
  const context = { config: loadServerConfig(), pool: {}, rateLimiter: new SlidingWindowRateLimiter() };
  await assert.rejects(handleAuthRoutes(request({ userId: "new_user", password: "\u00e9".repeat(37) }),
    { setHeader() {} }, new URL("http://localhost/auth/register"), context), { status: 422, code: "weak_password" });
});

test("rotating IP addresses cannot bypass the shared account login quota", async () => {
  const config = loadServerConfig();
  const context = { config: { ...config, rateLimits: { ...config.rateLimits, loginMax: 2 } },
    pool: { async query() { return { rowCount: 0, rows: [] }; } }, rateLimiter: new SlidingWindowRateLimiter() };
  for (let i = 0; i < 2; i++) {
    const req = request({ userId: "target_account", password: "password_123" });
    req.socket.remoteAddress = `192.0.2.${i + 1}`;
    await assert.rejects(handleAuthRoutes(req, { setHeader() {} }, new URL("http://local/auth/login"), context), { status: 401 });
  }
  const req = request({ userId: "target_account", password: "password_123" });
  req.socket.remoteAddress = "192.0.2.99";
  await assert.rejects(handleAuthRoutes(req, { setHeader() {} }, new URL("http://local/auth/login"), context), { status: 429 });
});
