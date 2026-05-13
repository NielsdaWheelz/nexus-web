# Production Auth Cutover

## Purpose

Production auth must be deterministic at the request boundary. A protected page
must never render unless the server has verified the current access token for
that request, and no Vercel middleware invocation may wait on Supabase Auth,
FastAPI, JWKS, or any other external system.

This is a hard cutover. There is no Render-era backend fallback, no local
cookie-presence authentication, no guest app mode, and no long-running token
refresh path during navigation.

## Incident Contract

The production failure was a Vercel `MIDDLEWARE_INVOCATION_TIMEOUT` on
`GET /libraries`. The failing path was a syntactically valid but expired
Supabase SSR cookie. Middleware called `supabase.auth.getUser()`, Supabase Auth
JS attempted refresh, each fetch aborted, the SDK retried, and Vercel killed the
middleware after 25 seconds.

The fix is not a larger timeout. The fix is to remove external auth work from
middleware and make every auth network operation own a total deadline.

## Goals

- Protected pages fail closed with a redirect to
  `/login?next=<requested path and query>`.
- API routes fail closed with structured JSON error envelopes.
- Middleware response time is independent of Supabase, FastAPI, the database,
  or the backend VPS.
- Expired, malformed, missing, or stale auth cookies do not trigger refresh
  loops during page navigation or BFF proxying.
- BFF routes forward only a server-read access token and server-only internal
  secret to FastAPI.
- FastAPI verifies JWTs with bounded JWKS access and no unauthenticated pass
  through.
- Production env sync refuses empty required values and verifies the deployed
  environment shape before deployment is considered complete.

## Non-Goals

- No anonymous app, oracle, library, browse, search, notes, media, settings, or
  conversation access.
- No middleware call to Supabase Auth.
- No page-navigation token refresh.
- No BFF `getSession()` dependency.
- No automatic backend fallback to Render or any other service.
- No bypass of Supabase Auth/JWT verification during a Supabase outage.
- No compatibility path for old cookie shapes beyond clearing them and
  redirecting to login.

## Request Classes

- Static/framework assets: bypass middleware work.
- Public pages: `/login`, `/terms`, `/privacy`.
- Public auth routes: `/auth/callback`, `/auth/signout`.
- Public extension connect start: `/extension/connect/start`.
- BFF routes: `/api/*`; middleware never redirects them.
- Protected app pages: every page in `apps/web/src/app/(authenticated)`.
- Protected oracle pages: every page in `apps/web/src/app/(oracle)`.

## Target Behavior

- Anonymous `GET /libraries` redirects to `/login?next=%2Flibraries`.
- Anonymous `GET /browse?x=1` redirects to
  `/login?next=%2Fbrowse%3Fx%3D1`.
- Anonymous `GET /terms`, `/privacy`, and `/login` render normally.
- Anonymous `GET /api/libraries` returns JSON `401 E_UNAUTHENTICATED`.
- Malformed Supabase auth cookies clear and redirect to login on protected
  pages.
- Expired Supabase auth cookies clear and redirect to login on protected pages.
- Expired Supabase auth cookies return JSON `401 E_UNAUTHENTICATED` on BFF
  routes.
- A Supabase Auth verification timeout in a protected page gate redirects to
  login and never renders app UI.
- A FastAPI JWT/JWKS verification failure rejects the API request and never
  injects a viewer.
- Missing production `FASTAPI_BASE_URL`, `NEXUS_INTERNAL_SECRET`,
  `NEXT_PUBLIC_SUPABASE_URL`, or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a deployment
  error, not a degraded runtime mode.

## Architecture

### Middleware

`apps/web/src/middleware.ts` and `apps/web/src/lib/supabase/middleware.ts` own
only local request classification, deterministic cookie-shape rejection, request
path forwarding, and CSP headers.

Middleware rules:

- Do not import `@supabase/ssr`.
- Do not create a Supabase client.
- Do not call `getUser()`, `getSession()`, `refreshSession()`, or any SDK method
  that can perform network I/O.
- Do not call FastAPI.
- Do not fetch JWKS.
- Do not refresh cookies.
- Do not treat cookie presence as authentication.
- If a protected page request has no valid unexpired Supabase auth cookie,
  redirect to login immediately and clear malformed or expired cookie chunks.
- If a protected page request has a valid unexpired Supabase auth cookie, pass
  the request to the server page gate with `x-nexus-request-path`.
- If a request is `/api` or `/api/*`, pass it through so route handlers return
  JSON.

Cookie parsing in middleware is only a deterministic latency optimization for
anonymous, malformed, and expired sessions. It is not an authorization decision.

### Supabase Session Cookie Boundary

Next.js server code needs one explicit boundary parser for Supabase SSR cookies.
That parser is the only shared auth helper introduced by this cutover because
protected page gates and BFF routes must interpret the same cookie format.

Parser rules:

- Derive the cookie prefix from `NEXT_PUBLIC_SUPABASE_URL`.
- Reconstruct chunked cookies in numeric chunk order.
- Accept only the current Supabase SSR `base64-<base64url JSON>` cookie shape.
- Parse only the fields this app needs: `access_token`, `expires_at`,
  `token_type`.
- Reject missing, malformed, unparseable, expired, or non-bearer sessions.
- Return a narrow success value containing the access token and expiry.
- Return a narrow failure reason for tests and logging.
- Do not use `refresh_token`.
- Do not perform network I/O.

### Protected Page Gate

`apps/web/src/lib/auth/protected.ts` owns protected page verification.

Protected gate rules:

- Read the Supabase SSR cookie with the boundary parser.
- Clear Supabase auth cookie chunks when the cookie is malformed or expired.
- Redirect to `/login?next=<requested path and query>` when the cookie is
  absent, invalid, expired, or verification fails.
- Verify unexpired tokens with `supabase.auth.getUser(accessToken)`, passing the
  access token explicitly.
- Wrap the whole verification operation in a single total deadline.
- Do not call no-argument `getUser()`.
- Do not call `getSession()`.
- Do not refresh tokens.
- Do not render route-group client shells until verification succeeds.

Passing the access token to `getUser(accessToken)` is intentional: it verifies
the token with Supabase Auth without loading the SSR session and without entering
the refresh-token retry path.

### BFF Proxy

`apps/web/src/lib/api/proxy.ts` remains transport-only.

BFF rules:

- Read the Supabase SSR cookie with the same boundary parser.
- Return JSON `401 E_UNAUTHENTICATED` when the cookie is missing, invalid, or
  expired.
- Do not call `supabase.auth.getSession()`.
- Do not refresh tokens.
- Do not forward browser cookies, browser `Authorization`, or browser
  `X-Nexus-Internal`.
- Forward only the server-read bearer token, the server-only internal secret,
  and a validated request ID to FastAPI.
- Return JSON `500 E_INTERNAL` before auth parsing when required production
  backend config is missing.
- Return JSON `502 E_UPSTREAM` or `504 E_UPSTREAM_TIMEOUT` for bounded FastAPI
  transport failures, preserving the request ID.

FastAPI remains responsible for JWT verification before it injects a viewer.

### Auth Callback And Signout

Auth utility routes remain public because they complete or clear sessions.

Rules:

- `/auth/callback` may exchange codes and set Supabase cookies.
- `/auth/signout` clears Supabase cookies.
- Both routes use bounded network operations.
- Neither route is protected by middleware or the protected page gate.

### FastAPI JWT Verification

FastAPI middleware remains the authoritative backend viewer boundary.

Rules:

- Verify every browser/BFF bearer token before injecting a viewer.
- Fetch JWKS with a bounded timeout.
- Cache successful JWKS responses for a named TTL.
- If JWKS is unavailable and no valid cached key can verify the token, fail
  closed with a structured auth/service-unavailable error.
- Do not accept unsigned tokens.
- Do not accept the Supabase anon key or service role key as user identity.
- Do not fall back to a shared JWT secret unless production is explicitly
  configured to use that verifier mode.

### Deployment Env

Production env sync is part of the auth cutover because empty Vercel values can
turn auth and BFF failures into confusing runtime defects.

Rules:

- Required production env vars must be non-empty before deploy:
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `FASTAPI_BASE_URL`, `NEXUS_INTERNAL_SECRET`, `SUPABASE_URL`,
  `SUPABASE_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_AUDIENCES`,
  `APP_PUBLIC_URL`, and `API_PUBLIC_URL`.
- Vercel env sync must verify pulled production values are non-empty after
  writing.
- Verification output may print names, lengths, and value classes, never secret
  values.
- Hetzner env sync must keep rejecting placeholders and must verify required
  backend values are non-empty before restarting services.
- Deployment docs must not describe Render as a production fallback.

## Key Decisions

- Middleware is a deterministic router, not an auth verifier.
- Server page gates verify protected UI requests.
- BFF routes extract access tokens locally and let FastAPI verify them.
- Expired sessions redirect to login instead of refreshing during navigation.
- A single Supabase cookie parser is worth the abstraction cost because two
  security boundaries depend on identical parsing.
- Total operation deadlines are required around external auth and backend
  network work; per-fetch aborts are not enough.
- Empty production env values are deployment defects.
- Caching JWKS inside a bounded TTL is normal verifier state, not a legacy
  fallback.

## Implementation Plan

1. Update middleware to remove Supabase imports and all external auth calls.
2. Add the Supabase SSR cookie parser and cookie-clear behavior.
3. Update the protected page gate to parse, verify explicit access tokens with a
   total deadline, and redirect/clear on failure.
4. Update the BFF proxy to parse the cookie locally instead of calling
   `getSession()`.
5. Audit auth callback/signout for total network deadlines.
6. Audit FastAPI JWT/JWKS verifier for bounded fetch, cache TTL, and fail-closed
   behavior.
7. Fix Vercel env sync so required production values cannot be written or left
   empty silently.
8. Remove Render fallback language from deployment docs.
9. Add tests that reproduce the expired-cookie middleware timeout case and prove
   it now returns promptly.
10. Deploy Vercel and, if FastAPI verifier changes, deploy Hetzner.
11. Run production smoke checks against anonymous, malformed-cookie,
    expired-cookie, and API routes.

## Files

- `docs/auth-production-cutover.md`: target-state contract and implementation
  plan.
- `deployment.md`: production deployment contract.
- `deploy/vercel/sync-env.sh`: Vercel env write and verification.
- `deploy/hetzner/sync-env.sh`: VPS env validation.
- `.env.example`: required env documentation.
- `apps/web/src/middleware.ts`: CSP plus middleware entrypoint.
- `apps/web/src/lib/supabase/middleware.ts`: local route classification.
- `apps/web/src/lib/auth/protected.ts`: protected page verification.
- `apps/web/src/lib/auth/session-cookie.ts`: Supabase SSR cookie boundary parser.
- `apps/web/src/app/(authenticated)/layout.tsx`: main app server gate.
- `apps/web/src/app/(oracle)/layout.tsx`: oracle server gate.
- `apps/web/src/lib/api/proxy.ts`: BFF token extraction and forwarding.
- `apps/web/src/lib/supabase/route-handler.ts`: auth utility route client.
- `python/nexus/auth/verifier.py`: FastAPI JWT/JWKS verification.
- `python/nexus/auth/middleware.py`: FastAPI viewer injection.

## Test Plan

Frontend unit tests:

- Middleware redirects no-cookie protected pages without creating a Supabase
  client.
- Middleware passes valid unexpired cookie-bearing protected pages through
  without network I/O.
- Middleware passes `/api/*` through without redirects.
- Middleware returns promptly for a valid-shaped expired Supabase cookie.
- Cookie parser accepts current valid SSR cookie shape.
- Cookie parser rejects malformed, chunk-missing, expired, non-bearer, and
  legacy/raw shapes.
- Protected gate redirects and clears invalid/expired cookies.
- Protected gate verifies explicit access tokens and renders only on success.
- Protected gate redirects when Supabase Auth verification exceeds the total
  deadline.
- BFF returns `401 E_UNAUTHENTICATED` for missing, malformed, or expired
  cookies without calling Supabase session APIs.
- BFF forwards only server-owned auth headers.
- Vercel env sync validation fails on empty required values.

Backend tests:

- JWT verifier uses cached JWKS inside TTL.
- JWT verifier times out bounded JWKS fetches.
- JWT verifier fails closed when JWKS is unavailable and no valid cached key
  verifies the token.
- FastAPI auth middleware never injects a viewer on verifier failure.

Production smoke checks:

- `GET /libraries` anonymous: `307` to login under 2 seconds.
- `GET /libraries` malformed cookie: `307` to login under 2 seconds.
- `GET /libraries` valid-shaped expired cookie: `307` to login under 2 seconds.
- `GET /browse?x=1` anonymous: `307` to login with preserved `next`.
- `GET /terms`, `/privacy`, `/login`: `200`.
- `GET /api/libraries` anonymous: JSON `401 E_UNAUTHENTICATED`.
- `GET /api/libraries` expired cookie: JSON `401 E_UNAUTHENTICATED`.
- `GET https://api.nexus.nielseriknandal.com/health`: `200`.

## Acceptance Criteria

- No production request can produce `MIDDLEWARE_INVOCATION_TIMEOUT` because of
  Supabase Auth, FastAPI, JWKS, or database latency.
- Vercel edge-middleware logs show no Supabase Auth errors.
- The expired-cookie reproduction returns a redirect, not a 25-second 504.
- Protected UI never renders from cookie presence alone.
- API routes return structured JSON failures instead of HTML or middleware
  redirects.
- Empty required Vercel env values cannot pass sync verification.
- All changed behavior is covered by focused tests and production smoke checks.
