# Rail Deployment

Rail can run locally as a long-lived Node.js process or as a Vercel serverless API. The Vercel entry point is `api/index.ts`; it reuses the same request routing and business logic as the local server.

## Architecture

Vercel hosts the HTTP function. A managed PostgreSQL provider stores wallets, users, authorizations, idempotency records, offline tokens, ledger entries, and outbox events. Vercel environment variables provide secrets at runtime.

The API is reachable over HTTPS, but it is not an unauthenticated public product. Payment routes require a JWT or scoped API key, and token-issue and sync routes require the server API key. Do not publish the deployment URL in the frontend until the frontend has been configured with the correct origin and credentials.

## Required Vercel variables

Configure these for the **Production** environment:

```text
DATABASE_URL=postgresql://...
RAIL_API_KEY=<long-random-server-key>
RAIL_API_KEY_SCOPES=offline_tokens:issue,sync:write
RAIL_SIGNING_SECRET=<long-random-signing-secret>
JWT_SECRET=<long-random-jwt-secret>
RAIL_ALLOWED_ORIGINS=https://your-frontend.example
RAIL_REQUIRE_JSON_CONTENT_TYPE=true
RAIL_EXPOSE_INTERNAL_ERRORS=false
RAIL_TRUST_PROXY_HEADERS=true
```

Use separate values for Preview and Development. Never upload `.env` or copy real secrets into `.env_example`.

## Database setup

Apply the schema from a trusted environment before enabling the Vercel deployment:

```bash
DATABASE_URL='postgresql://...' npm run migrate
```

Hosted requests do not run DDL migrations or the authorization expiry sweep. This prevents multiple serverless instances from competing over startup work. Run migrations as a release step, and schedule expiry cleanup separately when deploying beyond a project demo.

## Deploy

After linking the repository to a Vercel project, deploy with the Vercel dashboard or CLI. The build command is `npm run build`, and the rewrite sends API paths such as `/health` and `/v1/payments/execute` to the function at `/api`.

Before a production deployment, run:

```bash
npm run build
```

Then verify the deployment with an authenticated smoke test. A public `GET /health` response only confirms that the function is reachable; it does not prove that PostgreSQL, migrations, authentication, or payment execution are configured correctly.

## Operational limitations

The current sliding-window rate limiter is process-local. It protects each warm function instance, but it is not a globally shared limiter across all Vercel instances. For higher-risk or higher-volume use, move rate-limit counters to Redis or another shared store.

The current SSE event stream is designed for a long-lived Node process. It is explicitly disabled on Vercel serverless execution, so hosted clients should use `GET /v1/events` polling until event delivery is moved to a managed pub/sub service.

The authorization expiry sweep uses an interval in a warm process. Hosted production should add a scheduled job that calls a protected maintenance endpoint, or move expiry cleanup into transactional reads and a managed job system.

## Security checklist

- Use a managed PostgreSQL instance with TLS enabled.
- Keep the Vercel project private and restrict project collaborators.
- Use a random API key and separate secrets for each environment.
- Configure only the scopes required by the deployment; token issuance and synchronization are checked independently.
- Set `RAIL_ALLOWED_ORIGINS` to exact frontend origins; do not use `*`.
- Trust forwarded client-IP headers only when the hosting proxy is known to sanitize them.
- Keep `RAIL_EXPOSE_INTERNAL_ERRORS=false` in production.
- Do not use API keys in query strings for ordinary API calls.
- Rotate secrets if they are ever printed, committed, or shared.
- Treat this as a project/demo deployment until external provider, compliance, monitoring, backup, and incident-response requirements are completed.
