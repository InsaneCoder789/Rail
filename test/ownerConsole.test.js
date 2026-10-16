import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { ownerConsoleHtml, handleOwnerConsole } from "../dist/server/routes/ownerConsole.js";
import { loadServerConfig } from "../dist/server/config.js";

test("owner console document compiles without storage, external scripts, dynamic HTML or embedded credentials", () => {
  const html = ownerConsoleHtml("a".repeat(24));
  const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Script(script));
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "innerHTML", "document.write", "rail_agent_", "client_secret", "eval("])
    assert.equal(html.includes(forbidden), false, forbidden);
  assert.equal((html.match(/nonce="a{24}"/g) ?? []).length, 2);
  assert.ok(html.includes("external provider unavailable"));
  assert.ok(html.includes("No bank, card or UPI settlement"));
  assert.throws(() => ownerConsoleHtml('invalid"nonce'), /INVALID_CONSOLE_NONCE/);
});

test("owner console is opt-in, exact-path and non-production, with fresh CSP nonces and no caching", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const serve = (url = "/demo/owner", method = "GET", enabled = true) => {
      const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
      return { handled: handleOwnerConsole({ method, url }, res, new URL(url, "http://localhost"), { config: { ownerDemoEnabled: enabled } }), res };
    };
    for (const [url, method, enabled] of [["/demo/owner", "GET", false], ["/demo/owner?token=must_not_reflect", "GET", true],
      ["/demo/owner", "POST", true], ["/another", "GET", true]]) assert.equal(serve(url, method, enabled).handled, false);
    const first = serve(), second = serve();
    assert.equal(first.handled, true); assert.equal(first.res.status, 200);
    assert.equal(first.res.headers["Cache-Control"], "no-store"); assert.equal(first.res.headers["X-Frame-Options"], "DENY");
    assert.equal(first.res.headers["Referrer-Policy"], "no-referrer");
    assert.ok(first.res.headers["Content-Security-Policy"].includes("connect-src 'self'"));
    assert.ok(first.res.headers["Content-Security-Policy"].includes("frame-ancestors 'none'"));
    assert.notEqual(first.res.headers["Content-Security-Policy"], second.res.headers["Content-Security-Policy"]);
    process.env.NODE_ENV = "production"; assert.equal(serve().handled, false);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test("production cannot enable the demo through configuration", () => {
  const mode = process.env.RAIL_DEMO_MODE, environment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test"; delete process.env.RAIL_DEMO_MODE; assert.equal(loadServerConfig().ownerDemoEnabled, false);
    process.env.RAIL_DEMO_MODE = "true"; assert.equal(loadServerConfig().ownerDemoEnabled, true);
    process.env.NODE_ENV = "production"; assert.throws(loadServerConfig, /DEMO_REQUIRES_EXPLICIT_NON_PRODUCTION_MODE/);
  } finally {
    if (mode === undefined) delete process.env.RAIL_DEMO_MODE; else process.env.RAIL_DEMO_MODE = mode;
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  }
});
