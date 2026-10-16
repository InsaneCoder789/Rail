# Owner Console (C3 In Progress)

## Purpose And Availability

`GET /demo/owner` serves a small backend-hosted owner console when
`RAIL_DEMO_MODE=true` outside production. It is disabled by default. Production
configuration rejects that flag; the route also refuses production at request time.
This does not deploy the app, provision users, create synthetic money, add provider
instruments or change the separate payment-frontend project.

Use an isolated non-production database and an existing owner account with agents,
credentials and mandates configured through the authenticated APIs. The console
uses the existing real login, owner passkey and agent-management routes. Correct
`RAIL_WEBAUTHN_RP_ID` and `RAIL_WEBAUTHN_ORIGIN` must match the console origin;
localhost is accepted only outside production. Do not weaken origin checks to
make an incorrectly configured demo work.

Source/build and three document/configuration tests pass. Focused browser rerun
`job-mv9iwopf-0274e6f0` passed the actual console journey (one pass, zero failures,
two unrelated tests excluded by name); the disposable database was removed.
Desktop/mobile screenshots were inspected. The existing 398-backend/two-browser
baseline predates this console increment. The direct combined backend and all
three native browser regressions passed on 16 October, including the later hidden
total/fingerprint cleanup assertions. Audit found zero known advisories and the
disposable database was removed; this is not deployment/provider acceptance.

The first console browser run completed the authentication, approval, limit and
receipt journey but failed the mobile overflow check. The layout now gives grid
children and native selects explicit shrink boundaries. The rerun passed 320,
390 and 768 pixel viewport checks. The mobile table scrolls within its panel.

## Supported Controls

- Sign in to an existing owner account, refresh owned agents and shared budgets,
  and inspect total, reserved, spent and available policy allowance.
- Enroll a first passkey using current-password reauthentication, or add another
  factor using an existing key. Show recovery codes once, then clear their display.
- Load a selected agent's intents and inspect exact recipient, amount, currency,
  deadline, agent, shared-budget binding and full request fingerprint.
- Approve an exact pending intent with a real passkey, reject unexecuted work,
  and inspect server-verified authority receipt summaries.
- Change a shared limit with revision-bound passkey consent; revoke a budget,
  withdraw a member or revoke a selected agent using existing emergency controls.

Approval does not execute a payment. The independently authenticated agent client
must still request execution and pass live financial checks. Integer limit inputs
are minor units, not decimal currency amounts. Provider settlement and blockchain
verification are explicitly unavailable, not simulated as connected services.

## Security Decisions

Owner JWTs remain in a private page closure, not URLs, browser storage or globally
exposed variables. Password fields are cleared before requests. Clearing the page
session or leaving it aborts pending requests, invalidates in-page async actions and
clears sensitive displays. A completed passkey prompt after logout cannot submit
its mutation under a new page session. Clearing this page is not global server-side
session revocation; the UI states that distinction.

Dynamic values use text nodes rather than HTML insertion. The document has a fresh
per-response CSP nonce, same-origin-only connections, no external assets/scripts,
frame protection, no referrers and no caching. Redirects are refused. First-factor
recovery codes are cleared on dismissal/close/session cleanup. A password manager,
browser extension, compromised device or owner taking a screenshot is outside the
application's storage guarantee.

Requests are bounded by a browser timeout. There are no automatic mutation/payment
retries or background polling. Uncertain outcomes ask the owner to refresh before
retrying. All existing source/owner quotas and backend authentication remain in
force; frontend button state never substitutes for authorization.

## Design And Verification Plan

The local reference is `deliverables/rail-owner-console/concept.png`: a paper/ink/teal
control sheet with serif headings, tabular values, an owner/budget column, intent
table and exact-review/receipt panel. The implementation is real HTML/CSS/JavaScript,
not a raster screenshot. No new frontend framework is required.

Intentional differences: replace the concept's illustrative company names and
amounts with actual authenticated API values and truthful empty states; expose full
fingerprints, minor-unit input guidance and security/status copy; never retain a
masked password as though a session needs one. Membership/agent revocation controls
are required by C3 rather than invented marketing navigation.

Native Chromium acceptance uses a virtual authenticator and disposable database.
It exercises the actual console controls, detects page errors, attempts database
name-based HTML injection, verifies approval does not execute money, verifies exact
limit consent and receipts, asserts storage/session cleanup and checks mobile overflow.
Native Playwright/CDP is required for this controlled virtual-authenticator fixture;
an ordinary app browser tab cannot supply that authenticator setup.

Desktop/mobile screenshots in `deliverables/rail-owner-console` were inspected
against the concept: paper/ink/teal, serif hierarchy, bounded panels and complete
fingerprints remain; authenticated data and additional safety controls intentionally
replace illustrative content. A later change additionally clears hidden totals and
fingerprints on session cleanup and awaits combined browser regression. Dedicated
simulator code now exists; its updated three-process integration test and external
timeout/recovery demonstration remain acceptance gates. This console does not
complete C2 or C3.
