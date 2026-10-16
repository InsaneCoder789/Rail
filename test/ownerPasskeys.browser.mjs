import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID, randomBytes, generateKeyPairSync, createHash, sign } from "node:crypto";
import { hash } from "bcryptjs";
import { Pool } from "pg";
import { chromium } from "playwright";
import dotenv from "dotenv";
import { createServerContext, handleRequest } from "../dist/server/server.js";
import { credentialOperationFingerprint, credentialRotationFingerprint, mandateOperationFingerprint, approvalOperationFingerprint } from "../dist/persistence/agentAuthority.js";
import { ENROLLMENT_FINGERPRINT, RECOVERY_CODES_FINGERPRINT, revokePasskeyFingerprint } from "../dist/persistence/ownerPasskeys.js";
import { sharedBudgetOperationFingerprint } from "../dist/persistence/sharedBudgets.js";
import { mkdir } from "node:fs/promises";

dotenv.config();
const agentKeys = new Map();

// Native navigator.credentials generates the browser-managed origin, RP hash and signatures.
async function ceremony(page, request, registration) {
  return page.evaluate(async ({ options, registration }) => {
    const decode = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
    const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const publicKey = { ...options, challenge: decode(options.challenge), timeout: 6000 };
    if (registration) {
      publicKey.user = { ...options.user, id: decode(options.user.id) };
      publicKey.excludeCredentials = (options.excludeCredentials ?? []).map(value => ({ ...value, id: decode(value.id) }));
    } else publicKey.allowCredentials = (options.allowCredentials ?? []).map(value => ({ ...value, id: decode(value.id) }));
    const credential = registration ? await navigator.credentials.create({ publicKey }) : await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error("browser_credential_missing");
    const response = registration
      ? { clientDataJSON: encode(credential.response.clientDataJSON), attestationObject: encode(credential.response.attestationObject), transports: credential.response.getTransports() }
      : { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData),
        signature: encode(credential.response.signature), userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null };
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(), response };
  }, { options: request.options, registration });
}

async function api(page, token, path, body, expected = 200, method = "POST") {
  const isAgent = token?.startsWith("rail_agent_");
  let dpop;
  if (isAgent && path !== "/v2/agent/nonces") {
    const nonce = expected === 401 ? randomBytes(32).toString("base64url") : (await api(page, token, "/v2/agent/nonces", {})).nonce;
    const key = agentKeys.get(token);
    const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: key.publicKey.export({ format: "jwk" }) };
    const claims = { htm: method, htu: `${new URL(page.url()).origin}${path}`, iat: Math.floor(Date.now() / 1000),
      jti: randomBytes(32).toString("base64url"), nonce, ath: createHash("sha256").update(token).digest("base64url"),
      rail_body_sha256: createHash("sha256").update(body === undefined ? "" : JSON.stringify(body)).digest("base64url") };
    const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    dpop = `${input}.${sign(null, Buffer.from(input), key.privateKey).toString("base64url")}`;
  }
  const result = await page.evaluate(async ({ token, path, body, method, dpop, isAgent }) => {
    const response = await fetch(path, { method, headers: { ...(token ? { Authorization: `${isAgent ? "DPoP" : "Bearer"} ${token}` } : {}), ...(dpop ? { DPoP: dpop } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    return { status: response.status, noStore: response.headers.get("cache-control"), body: await response.json() };
  }, { token, path, body, method, dpop, isAgent });
  // Never include complete bodies in failure logs: they can contain fixture secrets.
  assert.equal(result.status, expected, `${method} ${path}: expected ${expected}, got ${result.status} (${result.body.error ?? "no error code"})`);
  if (path.startsWith("/auth/passkeys")) assert.equal(result.noStore, "no-store");
  return result.body;
}

async function stepUp(page, token, operation, operationFingerprint) {
  const options = await api(page, token, "/auth/passkeys/step-up/options", { operation, operationFingerprint });
  const response = await ceremony(page, options, false);
  const verified = await api(page, token, "/auth/passkeys/step-up/verify", { challengeId: options.challengeId, response });
  assert.equal(verified.userVerified, true);
  return verified.grantToken;
}

async function browserFixture(work, options = {}) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED_FOR_BROWSER_ACCEPTANCE");
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const schema = `ci_owner_browser_${randomUUID().replaceAll("-", "")}`;
  const oldEnvironment = new Map();
  let context, browser;
  const server = http.createServer((req, res) => {
    if (req.url === "/passkey-test") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; connect-src 'self'" });
      res.end("<!doctype html><html lang='en'><meta charset='utf-8'><title>Rail isolated passkey acceptance</title><h1>Rail browser acceptance fixture</h1><p>Synthetic funds and virtual authenticators only.</p></html>");
    } else if (context) void handleRequest(req, res, context);
    else { res.writeHead(503); res.end(); }
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://localhost:${server.address().port}`;
    const connection = new URL(process.env.DATABASE_URL);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const ring = name => JSON.stringify({ activeKeyId: name, keys: [{ keyId: name,
      encryptionKey: randomBytes(32).toString("base64"), authenticationKey: randomBytes(32).toString("base64") }] });
    const environment = { NODE_ENV: "test", DATABASE_URL: connection.toString(), RAIL_RUNTIME: "serverless", RAIL_TRUST_PROXY_HEADERS: "false",
      JWT_SECRET: randomBytes(32).toString("hex"), RAIL_SIGNING_SECRET: randomBytes(32).toString("hex"), RAIL_ALLOWED_ORIGINS: origin,
      RAIL_EVIDENCE_KEY_RING: ring("browser_payment"), RAIL_RISK_RECORD_KEY_RING: ring("browser_risk"), RAIL_AGENT_AUTHORITY_KEY_RING: ring("browser_authority"),
      RAIL_WEBAUTHN_RP_ID: "localhost", RAIL_WEBAUTHN_ORIGIN: origin, RAIL_AGENT_API_ORIGIN: origin, RAIL_MERCHANT_QUOTE_KEYS: undefined,
      RAIL_RISK_MODEL_PATH: undefined, RAIL_BEHAVIOUR_MODEL_PATH: undefined, RAIL_ANOMALY_MODEL_PATH: undefined,
      RAIL_PKCS11_MODULE_PATH: undefined, RAIL_KMS_KEY_ID: undefined, RAIL_DEMO_MODE: options.console ? "true" : undefined };
    for (const [key, value] of Object.entries(environment)) { oldEnvironment.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    context = await createServerContext({ initializeDatabase: true, startBackgroundJobs: false });
    const password = `browser_fixture_${randomUUID()}`, newPassword = `browser_recovered_${randomUUID()}`;
    await context.pool.query("INSERT INTO wallets(wallet_id,balance) VALUES('browser_owner',1000),('browser_receiver',0)");
    await context.pool.query("INSERT INTO users(user_id,password_hash,wallet_id) VALUES('browser_owner',$1,'browser_owner')", [await hash(password, 4)]);
    browser = await chromium.launch();
    const browserContext = await browser.newContext(), page = await browserContext.newPage();
    await page.goto(`${origin}/passkey-test`);
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    const cdp = await browserContext.newCDPSession(page); await cdp.send("WebAuthn.enable");
    const addAuthenticator = async () => (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
    await work({ context, server, page, browserContext, cdp, addAuthenticator, password, newPassword });
  } finally {
    if (browser) await browser.close();
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    if (context) await context.pool.end();
    for (const [key, value] of oldEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    agentKeys.clear();
  }
}

test("Chromium owner flow: native passkeys, exact payment approval, rotation, removal and scoped recovery", { timeout: 60000 }, async () => {
  await browserFixture(async ({ context, server, page, browserContext, cdp, addAuthenticator, password, newPassword }) => {
    let authenticator = await addAuthenticator();
    let { token } = await api(page, undefined, "/auth/login", { userId: "browser_owner", password });
    const registration = await api(page, token, "/auth/passkeys/register/options", { password });
    const firstResponse = await ceremony(page, registration, true);
    const first = await api(page, token, "/auth/passkeys/register/verify", { challengeId: registration.challengeId, response: firstResponse });
    assert.equal(first.userVerified, true); assert.equal(first.recoveryCodes.length, 10);
    await api(page, token, "/auth/passkeys/register/verify", { challengeId: registration.challengeId, response: firstResponse }, 409);

    const { agent } = await api(page, token, "/v2/agents", { name: "Browser-approved agent" }, 201);
    const agentPair = generateKeyPairSync("ed25519");
    const credentialBody = { scope: "payments:execute", ttlSeconds: 3600, publicKey: agentPair.publicKey.export({ format: "jwk" }) };
    await api(page, token, `/v2/agents/${agent.agentId}/credentials`, credentialBody, 403);
    const credentialGrant = await stepUp(page, token, "agent_credential", credentialOperationFingerprint(agent.agentId, credentialBody));
    const { credential } = await api(page, token, `/v2/agents/${agent.agentId}/credentials`, { ...credentialBody, grantToken: credentialGrant }, 201);
    agentKeys.set(credential.token, agentPair);
    const policy = { mode: "approval_required", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
      allowedReceiverWalletIds: ["browser_receiver"], ttlSeconds: 3600 };
    const mandateGrant = await stepUp(page, token, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy));
    await api(page, token, `/v2/agents/${agent.agentId}/mandates`, { ...policy, totalBudgetMinor: 2000, grantToken: mandateGrant }, 403);
    const { mandate } = await api(page, token, `/v2/agents/${agent.agentId}/mandates`, { ...policy, grantToken: mandateGrant }, 201);
    const { intent } = await api(page, credential.token, "/v2/agent/intents", { mandateId: mandate.mandateId, clientRequestId: "browser_payment_request", receiverWalletId: "browser_receiver", amountMinor: 100, currency: "INR" });
    const request = { requestFingerprint: intent.requestFingerprint }, decisionPath = `/v2/agents/${agent.agentId}/intents/${intent.intentId}/decision`;
    await api(page, token, decisionPath, { ...request, decision: "approve" }, 403);
    const approvalGrant = await stepUp(page, token, "agent_approval", approvalOperationFingerprint(agent.agentId, intent.intentId, intent.requestFingerprint));
    await api(page, token, decisionPath, { ...request, decision: "approve", grantToken: approvalGrant });
    const payment = await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request);
    assert.equal(payment.result.status, "accepted");
    const proofPath = `/v2/agents/${agent.agentId}/intents/${intent.intentId}/authority`;
    const proof = (await api(page, token, proofPath, undefined, 200, "GET")).authority;
    assert.equal(proof.status, "verified"); assert.equal(proof.ownerEvidence.approval.record.authentication.stepUp.credentialId, first.credentialId);
    assert.equal((await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request)).result.ledgerEntryId, payment.result.ledgerEntryId);

    const replacementPair = generateKeyPairSync("ed25519");
    const rotationBody = { scope: credential.scope, ttlSeconds: 3600, publicKey: replacementPair.publicKey.export({ format: "jwk" }) };
    const rotationPath = `/v2/agents/${agent.agentId}/credentials/${credential.credentialId}/rotate`;
    await api(page, token, rotationPath, rotationBody, 403);
    const agentRotationGrant = await stepUp(page, token, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, rotationBody));
    const { credential: rotatedAgent } = await api(page, token, rotationPath, { ...rotationBody, grantToken: agentRotationGrant }, 201);
    agentKeys.set(rotatedAgent.token, replacementPair);
    await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request, 401);
    assert.equal((await api(page, rotatedAgent.token, `/v2/agent/intents/${intent.intentId}/execute`, request)).result.ledgerEntryId, payment.result.ledgerEntryId);
    const history = (await api(page, token, `/v2/agents/${agent.agentId}/credentials`, undefined, 200, "GET")).credentials;
    assert.equal(history.find(item => item.credentialId === credential.credentialId).replacedByCredentialId, rotatedAgent.credentialId);
    assert.deepEqual((await api(page, token, proofPath, undefined, 200, "GET")).authority, proof);

    const enrollGrant = await stepUp(page, token, "passkey_enroll", ENROLLMENT_FINGERPRINT);
    const backupOptions = await api(page, token, "/auth/passkeys/register/options", { grantToken: enrollGrant });
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authenticator }); authenticator = await addAuthenticator();
    const second = await api(page, token, "/auth/passkeys/register/verify", { challengeId: backupOptions.challengeId, response: await ceremony(page, backupOptions, true) });
    assert.notEqual(second.credentialId, first.credentialId);
    const removalGrant = await stepUp(page, token, "passkey_revoke", revokePasskeyFingerprint(first.credentialId));
    await api(page, token, "/auth/passkeys/revoke", { credentialId: first.credentialId, grantToken: removalGrant });
    const lastGrant = await stepUp(page, token, "passkey_revoke", revokePasskeyFingerprint(second.credentialId));
    await api(page, token, "/auth/passkeys/revoke", { credentialId: second.credentialId, grantToken: lastGrant }, 409);
    const rotationGrant = await stepUp(page, token, "recovery_codes", RECOVERY_CODES_FINGERPRINT);
    const rotated = await api(page, token, "/auth/passkeys/recovery-codes/rotate", { grantToken: rotationGrant });
    assert.equal(rotated.recoveryCodes.length, 10);

    const recovered = await api(page, token, "/auth/passkeys/recover", { password, newPassword, recoveryCode: rotated.recoveryCodes[0] });
    await api(page, token, "/auth/passkeys", undefined, 401, "GET"); token = recovered.token;
    await api(page, token, "/v1/payments/authorize", { txId: "pending_browser_recovery", senderWalletId: "browser_owner", receiverWalletId: "browser_receiver", amountMinor: 1, currency: "INR" }, 403);
    await api(page, token, "/auth/passkeys/register/options", { password: newPassword }, 403);
    await api(page, rotatedAgent.token, `/v2/agent/intents/${intent.intentId}/execute`, request, 401);
    const recoverOptions = await api(page, token, "/auth/passkeys/register/options", { recoveryToken: recovered.recoveryToken });
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authenticator }); authenticator = await addAuthenticator();
    const replacement = await api(page, token, "/auth/passkeys/register/verify", { challengeId: recoverOptions.challengeId, response: await ceremony(page, recoverOptions, true) });
    assert.equal(replacement.recoveryCodes.length, 10);
    await api(page, token, "/auth/passkeys/register/options", { recoveryToken: recovered.recoveryToken }, 403);
    const historical = (await api(page, token, proofPath, undefined, 200, "GET")).authority;
    assert.equal(historical.commitment, proof.commitment);
    assert.equal((await context.pool.query("SELECT balance FROM wallets WHERE wallet_id='browser_receiver'")).rows[0].balance, "100");
    assert.equal((await context.pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await context.pool.query("SELECT * FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rowCount, 1);
    assert.equal((await context.pool.query("SELECT status FROM rail_agents WHERE agent_id=$1", [agent.agentId])).rows[0].status, "revoked");

    // The browser itself must reject an RP ID which does not match the page's origin.
    const wrongOrigin = await browserContext.newPage();
    await wrongOrigin.goto(`http://127.0.0.1:${server.address().port}/passkey-test`);
    await assert.rejects(ceremony(wrongOrigin, registration, true), /SecurityError|invalid domain|relying party/i);
  });
});

test("Chromium shared budget: native owner consent, signed spending, exact approval and immutable receipts", { timeout: 60000 }, async () => {
  await browserFixture(async ({ context, page, addAuthenticator, password }) => {
    await addAuthenticator();
    const { token } = await api(page, undefined, "/auth/login", { userId: "browser_owner", password });
    const registration = await api(page, token, "/auth/passkeys/register/options", { password });
    await api(page, token, "/auth/passkeys/register/verify", { challengeId: registration.challengeId, response: await ceremony(page, registration, true) });
    const { agent } = await api(page, token, "/v2/agents", { name: "Browser budget agent" }, 201);
    const pair = generateKeyPairSync("ed25519"), terms = { scope: "payments:execute", ttlSeconds: 3600, publicKey: pair.publicKey.export({ format: "jwk" }) };
    const credentialGrant = await stepUp(page, token, "agent_credential", credentialOperationFingerprint(agent.agentId, terms));
    const { credential } = await api(page, token, `/v2/agents/${agent.agentId}/credentials`, { ...terms, grantToken: credentialGrant }, 201);
    agentKeys.set(credential.token, pair);
    const budgetTerms = { name: "Browser shared budget", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 3600, agentIds: [agent.agentId] };
    await api(page, token, "/v2/budgets", budgetTerms, 403);
    const budgetGrant = await stepUp(page, token, "shared_budget", sharedBudgetOperationFingerprint("create", null, budgetTerms));
    const { budget } = await api(page, token, "/v2/budgets", { ...budgetTerms, grantToken: budgetGrant }, 201);
    const policy = { mode: "approval_required", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
      allowedReceiverWalletIds: ["browser_receiver"], ttlSeconds: 3600, sharedBudgetId: budget.budgetId };
    const mandateGrant = await stepUp(page, token, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy));
    const { mandate } = await api(page, token, `/v2/agents/${agent.agentId}/mandates`, { ...policy, grantToken: mandateGrant }, 201);
    const { intent } = await api(page, credential.token, "/v2/agent/intents", { mandateId: mandate.mandateId, clientRequestId: "browser_shared_request",
      receiverWalletId: "browser_receiver", amountMinor: 100, currency: "INR" });
    const before = (await api(page, token, "/v2/budgets", undefined, 200, "GET")).budgets[0];
    assert.deepEqual([before.reservedBudgetMinor, before.spentBudgetMinor, before.availableBudgetMinor], [100, 0, 900]);
    const request = { requestFingerprint: intent.requestFingerprint };
    await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request, 409);
    const approvalGrant = await stepUp(page, token, "agent_approval", approvalOperationFingerprint(agent.agentId, intent.intentId, intent.requestFingerprint));
    await api(page, token, `/v2/agents/${agent.agentId}/intents/${intent.intentId}/decision`, { ...request, decision: "approve", grantToken: approvalGrant });
    const payment = await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request);
    const replay = await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, request);
    assert.equal(replay.result.ledgerEntryId, payment.result.ledgerEntryId);
    const shared = (await api(page, token, "/v2/budgets", undefined, 200, "GET")).budgets[0];
    assert.deepEqual([shared.reservedBudgetMinor, shared.spentBudgetMinor, shared.availableBudgetMinor], [0, 100, 900]);
    const proof = (await api(page, token, `/v2/agents/${agent.agentId}/intents/${intent.intentId}/authority`, undefined, 200, "GET")).authority;
    assert.equal(proof.status, "verified"); assert.equal(proof.receipt.policy.sharedBudgetId, budget.budgetId);
    assert.equal((await context.pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("Chromium owner console: actual sign-in, passkeys, exact approval, budget controls, receipts and session cleanup", { timeout: 60000 }, async () => {
  await browserFixture(async ({ context, page, addAuthenticator, password }) => {
    await addAuthenticator();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1080 });
    const response = await page.goto(new URL("/demo/owner", page.url()).toString());
    assert.equal(response.status(), 200); assert.equal(response.headers()["cache-control"], "no-store");
    await page.locator("#user-id").fill("browser_owner"); await page.locator("#password").fill(password); await page.locator("#signin").click();
    await page.waitForFunction(() => document.getElementById("session-label").textContent === "Signed in as browser_owner" && !document.getElementById("enroll").disabled);
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.locator("#enrollment-password").fill(password); await page.locator("#enroll").click();
    await page.locator("#recovery").waitFor({ state: "visible" });
    assert.equal((await page.locator("#codes").textContent()).split("\n").length, 10);
    await page.locator("#dismiss-codes").click(); assert.equal(await page.locator("#codes").textContent(), "");
    // Setup uses the actual owner API and authenticator, not a privileged browser storage token.
    const { token } = await api(page, undefined, "/auth/login", { userId: "browser_owner", password });
    const { agent } = await api(page, token, "/v2/agents", { name: '<img src=x onerror="window.untrustedExecuted=true">' }, 201);
    const pair = generateKeyPairSync("ed25519"), terms = { scope: "payments:execute", ttlSeconds: 3600, publicKey: pair.publicKey.export({ format: "jwk" }) };
    const credentialGrant = await stepUp(page, token, "agent_credential", credentialOperationFingerprint(agent.agentId, terms));
    const { credential } = await api(page, token, `/v2/agents/${agent.agentId}/credentials`, { ...terms, grantToken: credentialGrant }, 201);
    agentKeys.set(credential.token, pair);
    const budgetTerms = { name: "Console allowance", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 3600, agentIds: [agent.agentId] };
    const budgetGrant = await stepUp(page, token, "shared_budget", sharedBudgetOperationFingerprint("create", null, budgetTerms));
    const { budget } = await api(page, token, "/v2/budgets", { ...budgetTerms, grantToken: budgetGrant }, 201);
    const policy = { mode: "approval_required", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
      allowedReceiverWalletIds: ["browser_receiver"], ttlSeconds: 3600, sharedBudgetId: budget.budgetId };
    const mandateGrant = await stepUp(page, token, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy));
    const { mandate } = await api(page, token, `/v2/agents/${agent.agentId}/mandates`, { ...policy, grantToken: mandateGrant }, 201);
    const { intent } = await api(page, credential.token, "/v2/agent/intents", { mandateId: mandate.mandateId, clientRequestId: "console_exact_request",
      receiverWalletId: "browser_receiver", amountMinor: 100, currency: "INR" });
    await page.locator("#refresh").click();
    await page.waitForFunction(() => document.getElementById("budget").options.length === 1 && !document.getElementById("load-intents").disabled);
    assert.equal(await page.evaluate(() => window.untrustedExecuted), undefined);
    assert.equal(await page.locator("#agent option").textContent(), agent.name + " / active");
    await page.locator("#load-intents").click(); await page.locator("#intent-rows button").click();
    assert.equal(await page.locator("#fingerprint").textContent(), intent.requestFingerprint);
    await page.locator("#approve").click();
    await page.waitForFunction(() => document.getElementById("review-detail").textContent.includes("Status: approved") && !document.getElementById("refresh").disabled);
    assert.equal((await context.pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    await page.locator("#new-limit").fill("900"); await page.locator("#limit").click();
    await page.waitForFunction(() => document.getElementById("budget-state").textContent.includes("revision 2") && !document.getElementById("refresh").disabled);
    await api(page, credential.token, `/v2/agent/intents/${intent.intentId}/execute`, { requestFingerprint: intent.requestFingerprint });
    await page.locator("#load-intents").click();
    await page.waitForFunction(() => document.querySelector("#intent-rows .status")?.textContent === "executed" && !document.getElementById("refresh").disabled);
    await page.locator("#intent-rows button").click(); await page.locator("#verify").click();
    await page.waitForFunction(() => document.getElementById("receipt").textContent.includes('"verification": "verified"') && !document.getElementById("refresh").disabled);
    await page.locator("#refresh").click();
    await page.waitForFunction(() => document.getElementById("spent").textContent.includes("1.00") && !document.getElementById("refresh").disabled);
    assert.equal((await context.pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await mkdir("deliverables/rail-owner-console", { recursive: true });
    await page.screenshot({ path: "deliverables/rail-owner-console/desktop.png", fullPage: true });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      assert.ok(dimensions.content <= dimensions.viewport, `Console overflows at ${width}px: ${JSON.stringify(dimensions)}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "deliverables/rail-owner-console/mobile.png", fullPage: true });
    await page.locator("#clear-session").click();
    assert.equal(await page.locator("#session-label").textContent(), "Not signed in");
    assert.equal(await page.locator("#receipt").textContent(), ""); assert.equal(await page.locator("#enrollment-password").inputValue(), "");
    assert.equal(await page.locator("#fingerprint").textContent(), ""); assert.equal(await page.locator("#spent").textContent(), "Not loaded");
    assert.equal(await page.locator("#review-body").isVisible(), false);
    assert.deepEqual(errors, []);
  }, { console: true });
});
