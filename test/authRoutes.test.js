import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleAuthRoutes } from "../dist/server/routes/authRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";
import { SlidingWindowRateLimiter } from "../dist/server/http.js";

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
      await assert.rejects(handleAuthRoutes(request(body), {}, new URL(`http://localhost${path}`), { config: loadServerConfig() }),
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
