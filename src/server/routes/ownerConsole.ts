import type http from "node:http";
import { randomBytes } from "node:crypto";
import type { ServerContext } from "../types.js";

const STYLE = String.raw`
:root{color-scheme:light;--paper:#f5f3ec;--ink:#162b31;--accent:#176457;--line:#9fada9;--muted:#536665;--warn:#f7e6b5}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 Menlo,Consolas,monospace}
main{max-width:1480px;margin:auto;padding:24px 30px 40px}header{margin-bottom:24px}.brand{font:700 76px/1 Georgia,serif;letter-spacing:-3px}
h1{font:700 36px/1.2 Georgia,serif;margin:0 0 4px}h2{font:700 27px/1.2 Georgia,serif;margin:0 0 18px;padding-bottom:9px;border-bottom:1px solid var(--line)}
h3{font:700 19px Georgia,serif}p{margin:6px 0 14px}.layout{display:grid;grid-template-columns:310px minmax(0,1fr);gap:20px;align-items:start}
aside,.panel{border:1px solid var(--line);padding:16px}.layout>*{min-width:0}input,select{min-width:0;max-width:100%}.panel{margin-bottom:16px}aside section+section{border-top:1px solid var(--line);padding-top:20px;margin-top:20px}
label{display:block;margin:10px 0 5px}input,select,button{font:inherit;border:1px solid var(--line);border-radius:2px;min-height:42px;padding:8px 10px;color:var(--ink);background:transparent;width:100%}
button{cursor:pointer;margin-top:9px;font-weight:600}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button:disabled,input:disabled,select:disabled{opacity:.55;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #c29241;outline-offset:3px}.row{display:flex;gap:16px;align-items:end}.row>*{flex:1;min-width:0}.row button{max-width:235px;margin:0}
.small{font-size:12px;color:var(--muted)}.amounts{display:grid;grid-template-columns:1fr auto;gap:8px;margin:16px 0}.amounts dt,.amounts dd{margin:0}.amounts dd{font-variant-numeric:tabular-nums;text-align:right}.available{color:var(--accent);font-weight:700}
.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{border:1px solid var(--line);padding:12px 14px;vertical-align:middle}th{font-weight:700}td button{margin:0;min-width:80px}
.status{padding:4px 9px;background:var(--warn);display:inline-block}.status.executed{background:#d9e9dd}.empty{padding:20px 0;color:var(--muted)}
.review{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:22px}.receipt{border-left:1px solid var(--line);padding-left:22px}.break,code,pre{overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;font:inherit}.fingerprint{display:block;border:1px dashed var(--line);padding:9px;font-size:12px}
#message{min-height:25px;margin-bottom:14px}#message[data-error=true]{color:#913c21}dialog{max-width:600px;width:calc(100% - 32px);background:var(--paper);border:2px solid var(--ink);color:var(--ink);padding:24px}dialog::backdrop{background:#162b3180}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(max-width:850px){main{padding:18px 16px}.layout{grid-template-columns:minmax(0,1fr)}.brand{font-size:58px}h1{font-size:30px}.review{grid-template-columns:minmax(0,1fr)}.receipt{padding:0;border:0;border-top:1px solid var(--line)}.row{flex-wrap:wrap}.row button{max-width:none}.row>*{flex-basis:100%}th,td{padding:8px}table{font-size:12px}.panel,aside{padding:14px}}
`;

const SCRIPT = String.raw`
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let token = null, epoch = 0, busy = false, budgets = [], agents = [], intents = [], reviewed = null;
  const requests = new Set();
  const message = (text, error = false) => { el('message').textContent = text; el('message').dataset.error = String(error); };
  const ensure = expected => { if (expected !== epoch) throw new Error('session_cleared'); };
  const money = (amount, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount / 100);
  const selectedBudget = () => budgets.find(item => item.budgetId === el('budget').value);
  const endpoint = (agentId, intentId, action) => '/v2/agents/' + encodeURIComponent(agentId) + '/intents/' + encodeURIComponent(intentId) + '/' + action;
  function sync() {
    document.querySelectorAll('[data-auth]').forEach(node => { node.hidden = !token; });
    document.querySelectorAll('button,input,select').forEach(node => {
      if (node.id === 'clear-session') { node.disabled = !token; return; }
      node.disabled = busy;
    });
    el('signin').disabled = busy || Boolean(token);
    el('approve').disabled = busy || !reviewed || reviewed.status !== 'pending';
    el('reject').disabled = busy || !reviewed || !['pending','approved'].includes(reviewed.status);
    el('verify').disabled = busy || !reviewed;
    el('limit').disabled = busy || !selectedBudget() || selectedBudget().status !== 'active';
    el('revoke-budget').disabled = busy || !selectedBudget() || selectedBudget().status !== 'active';
    el('withdraw').disabled = busy || !selectedBudget() || !el('member').value || selectedBudget().status !== 'active';
    el('load-intents').disabled = busy || !el('agent').value;
    el('revoke-agent').disabled = busy || !el('agent').value;
  }
  function clearSession() {
    epoch++; token = null; budgets = []; agents = []; intents = []; reviewed = null;
    requests.forEach(controller => controller.abort()); requests.clear();
    ['password','enrollment-password','codes','receipt','review-detail','fingerprint','new-limit','budget-state'].forEach(id => { const node = el(id); if (node.tagName === 'INPUT') node.value = ''; else node.textContent = ''; });
    ['total','reserved','spent','available'].forEach(id => { el(id).textContent = 'Not loaded'; });
    ['budget','agent','member'].forEach(id => el(id).replaceChildren());
    el('intent-rows').replaceChildren(); el('recovery').close(); el('session-label').textContent = 'Not signed in';
    el('review-empty').hidden = false; el('review-body').hidden = true;
    message('Session cleared from this page. Existing server sessions are not revoked.'); sync();
  }
  async function api(path, body, method = 'POST', expected = epoch) {
    ensure(expected);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000); requests.add(controller);
    try {
      const response = await fetch(path, { method, redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); ensure(expected);
      if (!response.ok) {
        const code = typeof data.error === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(data.error) ? data.error : 'request_failed';
        const retry = response.headers.get('Retry-After');
        const error = new Error(code + (response.status === 429 && /^\d{1,6}$/.test(retry || '') ? '; retry after ' + retry + ' seconds' : ''));
        if (response.status === 401 && token) clearSession();
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  async function run(action) {
    if (busy) return; busy = true; sync(); const expected = epoch;
    try { await action(expected); }
    catch (error) { if (expected === epoch) message((error.name === 'AbortError' ? 'Request outcome unknown' : error.message) + '. Refresh before retrying; no automatic payment retry was made.', true); }
    finally { busy = false; sync(); }
  }
  const hashTuple = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))))
    .map(byte => byte.toString(16).padStart(2,'0')).join('');
  const decode = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), character => character.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  async function ceremony(options, registration) {
    if (!window.isSecureContext || !navigator.credentials) throw new Error('secure_passkey_context_required');
    const publicKey = { ...options, challenge: decode(options.challenge) };
    if (registration) { publicKey.user = { ...options.user, id: decode(options.user.id) }; publicKey.excludeCredentials = (options.excludeCredentials || []).map(item => ({ ...item, id: decode(item.id) })); }
    else publicKey.allowCredentials = (options.allowCredentials || []).map(item => ({ ...item, id: decode(item.id) }));
    const credential = registration ? await navigator.credentials.create({ publicKey }) : await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error('passkey_cancelled');
    const response = registration ? { clientDataJSON: encode(credential.response.clientDataJSON), attestationObject: encode(credential.response.attestationObject), transports: credential.response.getTransports() }
      : { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature), userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null };
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults(), response };
  }
  async function stepUp(operation, operationFingerprint, expected) {
    const request = await api('/auth/passkeys/step-up/options', { operation, operationFingerprint }, 'POST', expected);
    const response = await ceremony(request.options, false); ensure(expected);
    const verified = await api('/auth/passkeys/step-up/verify', { challengeId: request.challengeId, response }, 'POST', expected);
    return verified.grantToken;
  }
  function options(select, items, value, label) {
    const before = select.value; select.replaceChildren();
    for (const item of items) { const option = document.createElement('option'); option.value = value(item); option.textContent = label(item); select.append(option); }
    if (items.some(item => value(item) === before)) select.value = before;
  }
  function renderBudget() {
    const budget = selectedBudget();
    for (const [id, field] of [['total','totalBudgetMinor'],['reserved','reservedBudgetMinor'],['spent','spentBudgetMinor'],['available','availableBudgetMinor']])
      el(id).textContent = budget ? money(budget[field], budget.currency) : 'Not loaded';
    el('budget-state').textContent = budget ? budget.status + ' / revision ' + budget.revision : 'No shared budgets';
    el('new-limit').value = budget ? String(budget.totalBudgetMinor) : '';
    options(el('member'), budget ? budget.members.filter(member => member.status === 'active') : [], item => item.agentId, item => item.agentId);
  }
  function renderIntents() {
    el('intent-rows').replaceChildren(); el('intents-empty').hidden = intents.length > 0;
    for (const intent of intents) {
      const row = document.createElement('tr');
      for (const text of [intent.receiverWalletId, money(intent.amountMinor,intent.currency)]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      const status = document.createElement('td'), tag = document.createElement('span'); tag.className = 'status' + (intent.status === 'executed' ? ' executed' : ''); tag.textContent = intent.status; status.append(tag); row.append(status);
      const cell = document.createElement('td'), button = document.createElement('button'); button.textContent = 'Review';
      button.onclick = () => { reviewed = { ...intent }; renderReview(); sync(); }; cell.append(button); row.append(cell); el('intent-rows').append(row);
    }
  }
  function renderReview() {
    el('review-empty').hidden = Boolean(reviewed); el('review-body').hidden = !reviewed;
    el('receipt').textContent = '';
    if (!reviewed) return;
    el('review-detail').textContent = 'Recipient: ' + reviewed.receiverWalletId + '\nAmount: ' + money(reviewed.amountMinor, reviewed.currency) +
      '\nAgent: ' + reviewed.agentId + '\nShared budget: ' + (reviewed.sharedBudgetId || 'No shared envelope') + '\nStatus: ' + reviewed.status + '\nDeadline: ' + reviewed.expiresAt;
    el('fingerprint').textContent = reviewed.requestFingerprint;
  }
  async function refresh(expected) {
    const [ownedAgents, ownedBudgets] = await Promise.all([api('/v2/agents',undefined,'GET',expected),api('/v2/budgets',undefined,'GET',expected)]);
    agents = ownedAgents.agents; budgets = ownedBudgets.budgets;
    options(el('agent'),agents,item=>item.agentId,item=>item.name + ' / ' + item.status); options(el('budget'),budgets,item=>item.budgetId,item=>item.name);
    renderBudget();
  }
  async function loadIntents(expected) {
    const id = el('agent').value; if (!id) throw new Error('select_an_agent');
    intents = (await api('/v2/agents/' + encodeURIComponent(id) + '/intents',undefined,'GET',expected)).intents;
    reviewed = null; renderIntents(); renderReview();
  }
  el('login').onsubmit = event => { event.preventDefault(); run(async expected => {
    const userId = el('user-id').value, password = el('password').value; el('password').value = '';
    const response = await api('/auth/login', { userId, password }, 'POST', expected);
    if (typeof response.token !== 'string') throw new Error('invalid_login_response');
    token = response.token; el('session-label').textContent = 'Signed in as ' + userId; await refresh(expected); message('Owner session is held only in this page memory.');
  }); };
  el('clear-session').onclick = clearSession;
  el('enroll').onclick = () => run(async expected => {
    const password = el('enrollment-password').value; el('enrollment-password').value = '';
    const existing = (await api('/auth/passkeys',undefined,'GET',expected)).passkeys.some(key => !key.revokedAt);
    const grantToken = existing ? await stepUp('passkey_enroll',await hashTuple(['rail:owner-operation:v1','passkey_enroll']),expected) : undefined;
    const request = await api('/auth/passkeys/register/options',existing ? { grantToken } : { password },'POST',expected);
    const response = await ceremony(request.options,true); ensure(expected);
    const result = await api('/auth/passkeys/register/verify',{ challengeId: request.challengeId, response },'POST',expected);
    if (result.recoveryCodes) { el('codes').textContent = result.recoveryCodes.join('\n'); el('recovery').showModal(); }
    message('Passkey enrolled. Keep recovery codes outside the application.');
  });
  el('dismiss-codes').onclick = () => { el('codes').textContent = ''; el('recovery').close(); };
  el('recovery').addEventListener('close',()=>{ el('codes').textContent = ''; });
  el('refresh').onclick = () => run(async expected => { await refresh(expected); message('Owner data refreshed.'); });
  el('budget').onchange = () => { renderBudget(); sync(); };
  el('agent').onchange = () => { reviewed = null; intents = []; renderIntents(); renderReview(); sync(); };
  el('load-intents').onclick = () => run(async expected => { await loadIntents(expected); message('Agent intents loaded.'); });
  for (const decision of ['approve','reject']) el(decision).onclick = () => run(async expected => {
    if (!reviewed) throw new Error('select_an_intent'); const intent = { ...reviewed };
    const grantToken = decision === 'approve' ? await stepUp('agent_approval',await hashTuple(['rail:owner-operation:v1','agent_approval',intent.agentId,intent.intentId,intent.requestFingerprint]),expected) : undefined;
    const result = await api(endpoint(intent.agentId,intent.intentId,'decision'),{ decision, requestFingerprint: intent.requestFingerprint, ...(grantToken ? { grantToken } : {}) },'POST',expected);
    intents = intents.map(item=>item.intentId===intent.intentId ? result.intent : item); reviewed = result.intent; renderIntents(); renderReview();
    message(decision === 'approve' ? 'Exact intent approved. Approval does not execute or settle a payment.' : 'Intent rejected. Refresh to inspect released allowance.');
  });
  el('verify').onclick = () => run(async expected => {
    if (!reviewed) throw new Error('select_an_intent'); const intent = { ...reviewed };
    const value = (await api(endpoint(intent.agentId,intent.intentId,'authority'),undefined,'GET',expected)).authority, receipt = value.receipt;
    el('receipt').textContent = JSON.stringify({ verification: value.status, assurance: receipt && receipt.assurance, txId: receipt && receipt.txId,
      agentId: receipt && receipt.agentId, amountMinor: receipt && receipt.amountMinor, currency: receipt && receipt.policy.currency,
      consentSource: receipt && receipt.consentSource, sharedBudgetId: receipt && receipt.policy.sharedBudgetId, commitment: value.commitment },null,2);
    message('Server-verified authority is not a blockchain attestation or external settlement confirmation.');
  });
  el('limit').onclick = () => run(async expected => {
    const budget = selectedBudget(), totalBudgetMinor = Number(el('new-limit').value);
    if (!budget || !Number.isSafeInteger(totalBudgetMinor) || totalBudgetMinor < 1 || totalBudgetMinor > 1e12) throw new Error('invalid_limit_minor_units');
    const grantToken = await stepUp('shared_budget',await hashTuple(['rail:owner-operation:v1','shared_budget','limit',budget.budgetId,[budget.revision,totalBudgetMinor]]),expected);
    const result = await api('/v2/budgets/' + encodeURIComponent(budget.budgetId) + '/limit',{ revision: budget.revision, totalBudgetMinor, grantToken },'POST',expected);
    budgets = budgets.map(item=>item.budgetId === budget.budgetId ? { ...item, ...result.budget } : item); renderBudget(); message('Limit changed with exact owner consent.');
  });
  el('revoke-budget').onclick = () => run(async expected => {
    const budget = selectedBudget(); if (!budget || !window.confirm('Permanently revoke this shared budget? Posted transfers remain unchanged.')) return;
    const result = await api('/v2/budgets/' + encodeURIComponent(budget.budgetId) + '/revoke',{},'POST',expected);
    budgets = budgets.map(item=>item.budgetId === budget.budgetId ? { ...item, ...result.budget } : item); renderBudget(); reviewed = null; intents = []; renderIntents(); renderReview(); message('Budget revoked. Unspent internal holds released; posted history preserved.');
  });
  el('withdraw').onclick = () => run(async expected => {
    const budget = selectedBudget(), agentId = el('member').value; if (!budget || !agentId || !window.confirm('Permanently withdraw this member?')) return;
    const result = await api('/v2/budgets/' + encodeURIComponent(budget.budgetId) + '/member_remove',{ agentId },'POST',expected);
    budgets = budgets.map(item=>item.budgetId === budget.budgetId ? { ...item, ...result.budget, members: item.members.map(member=>member.agentId===agentId ? { ...member,status:'revoked' } : member) } : item);
    renderBudget(); reviewed = null; intents = []; renderIntents(); renderReview(); message('Membership withdrawn. Refresh agent intents to inspect terminal states.');
  });
  el('revoke-agent').onclick = () => run(async expected => {
    const agentId = el('agent').value; if (!agentId || !window.confirm('Permanently revoke this agent and its delegated authority?')) return;
    await api('/v2/agents/' + encodeURIComponent(agentId) + '/revoke',{},'POST',expected); await loadIntents(expected); message('Agent revoked. Other agents are not revoked by this action.');
  });
  window.addEventListener('pagehide',clearSession); sync();
})();
`;

export function ownerConsoleHtml(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{24}$/.test(nonce)) throw new Error("INVALID_CONSOLE_NONCE");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rail / Owner console</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main><header><div class="brand">Rail</div><h1>Owner console</h1><p>Internal wallet demo / external provider unavailable</p></header><p id="message" role="status" aria-live="polite">Sign in with an existing owner account. No synthetic balances are generated by this page.</p>
<div class="layout"><aside><section><h2>Owner session</h2><p id="session-label">Not signed in</p><form id="login"><label for="user-id">User ID</label><input id="user-id" autocomplete="username" required maxlength="128"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><button id="signin" class="primary">Sign in</button></form><button id="clear-session">Clear session</button></section>
<section data-auth hidden><h3>Passkey</h3><label for="enrollment-password">Current password for first enrollment</label><input id="enrollment-password" type="password" autocomplete="current-password"><button id="enroll">Enroll passkey</button><p class="small">Existing factors require passkey approval. Recovery codes appear once and are never saved here.</p></section>
<section data-auth hidden><h2>Shared budget</h2><label for="budget">Budget</label><select id="budget"></select><p id="budget-state" class="small"></p><dl class="amounts"><dt>Total limit</dt><dd id="total">Not loaded</dd><dt>Reserved</dt><dd id="reserved">Not loaded</dd><dt>Spent</dt><dd id="spent">Not loaded</dd><dt class="available">Available</dt><dd class="available" id="available">Not loaded</dd></dl><button id="refresh">Refresh</button>
<label for="new-limit">New limit (integer minor units)</label><input id="new-limit" type="number" min="1" max="1000000000000" step="1"><p class="small">INR 100.00 = 10000 minor units.</p><button id="limit" class="primary">Approve limit change</button><button id="revoke-budget">Revoke budget</button><label for="member">Active member</label><select id="member"></select><button id="withdraw">Withdraw member</button></section></aside>
<div><section class="panel" data-auth hidden><h2>Agent</h2><div class="row"><div><label class="sr-only" for="agent">Agent</label><select id="agent"></select></div><button id="load-intents" class="primary">Load intents</button></div><button id="revoke-agent">Revoke selected agent</button></section>
<section class="panel" data-auth hidden><h2>Payment intents</h2><p id="intents-empty" class="empty">Select an agent and load its intents.</p><div class="table-wrap"><table><caption class="sr-only">Owner-visible agent payment intents</caption><thead><tr><th scope="col">Recipient</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Review</th></tr></thead><tbody id="intent-rows"></tbody></table></div></section>
<section class="panel" data-auth hidden><h2>Exact payment review</h2><p id="review-empty" class="empty">Select Review on an intent. Changed terms cannot reuse approval.</p><div id="review-body" class="review" hidden><div><pre id="review-detail"></pre><label for="fingerprint">Request fingerprint</label><code id="fingerprint" class="fingerprint"></code><button id="approve" class="primary">Approve with passkey</button><button id="reject">Reject</button></div><div class="receipt"><h3>Verify receipt</h3><pre id="receipt" class="small"></pre><button id="verify">Verify receipt</button><p class="small">Server-observed authority only. No blockchain attestation or provider settlement is claimed.</p></div></div><p class="small">No bank, card or UPI settlement. Synthetic funds belong only in an isolated demo database.</p></section>
<section class="panel" id="welcome"><h2>Owner-controlled payments</h2><p>Agents can request payments, but cannot approve their own exceptions or change shared limits.</p><p class="small">Use preconfigured agents and mandates. This console does not execute agent code, store signing keys or provision payment instruments. Refresh manually; request quotas remain enforced.</p></section></div></div></main>
<dialog id="recovery" aria-labelledby="recovery-title"><h2 id="recovery-title">Recovery codes: keep offline</h2><p>These one-use codes are shown once. Store them securely outside this browser, then dismiss. Clearing the session also removes this display.</p><pre id="codes"></pre><button id="dismiss-codes">Dismiss and clear codes</button></dialog><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

export function handleOwnerConsole(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: ServerContext): boolean {
  if (!context.config.ownerDemoEnabled || process.env.NODE_ENV === "production" || req.method !== "GET" ||
      url.pathname !== "/demo/owner" || req.url !== "/demo/owner") return false;
  const nonce = randomBytes(18).toString("base64url");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
  res.end(ownerConsoleHtml(nonce)); return true;
}
