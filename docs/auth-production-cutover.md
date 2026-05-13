# Production Auth Cutover

## Purpose

Nexus production must not render protected application UI unless the server has
verified the user session for that request. A stale cookie, transient Supabase
Auth error, missing backend secret, or unavailable API must fail closed with a
clear redirect or structured error. The previous behavior of allowing page
navigation based on local auth-cookie presence is removed.

## Target Behavior

- Public pages (`/login`, `/terms`, `/privacy`) render without an auth check.
- Auth utility routes (`/auth/callback`, `/auth/signout`) remain public so they
  can complete or clear the Supabase session.
- API routes (`/api/*`) are not redirected by middleware. They return JSON error
  envelopes from the BFF when the request is unauthenticated or misconfigured.
- Protected page routes are gated server-side before the client shell mounts.
- Unauthenticated protected page requests redirect to
  `/login?next=<requested path and query>`.
- Supabase Auth failures during protected page verification do not pass through
  to the app shell. They fail closed as unauthenticated for navigation purposes.
- Browser code calls only same-origin `/api/*` BFF routes, except direct SSE
  streaming with a short-lived stream token.
- The BFF extracts the Supabase access token from the server cookie session and
  forwards only that token plus the server-only internal secret to FastAPI.
- Missing production backend configuration is a deployment error, not a degraded
  runtime mode.

## Architecture

### Request Classes

- Static and framework assets: ignored by the Next.js middleware matcher.
- Public pages: `/login`, `/terms`, `/privacy`.
- Public auth routes: `/auth/callback`, `/auth/signout`.
- BFF routes: `/api/*`.
- Protected app pages: every page in `apps/web/src/app/(authenticated)`.
- Protected oracle pages: every page in `apps/web/src/app/(oracle)`.
- Extension connect start: route-handler-owned auth flow; the route validates its
  redirect target and redirects unauthenticated users through login.

### Auth Boundaries

- `apps/web/src/lib/supabase/middleware.ts` owns request classification and
  Supabase cookie refresh for cookie-bearing protected requests. It never treats
  cookie presence as authentication; no-cookie protected requests redirect before
  any Supabase network call.
- `apps/web/src/lib/auth/protected.ts` owns server-side protected page gating.
  It verifies the Supabase user for the current request and redirects otherwise.
- Route group layouts call the protected gate before rendering client shells.
- Client components may still handle API `401` responses for expired sessions,
  but client handling is defense in depth, not the primary page gate.

### BFF Boundary

- `apps/web/src/lib/api/proxy.ts` remains transport-only.
- It never forwards browser cookies, browser `Authorization`, or browser
  `X-Nexus-Internal`.
- It returns `E_UNAUTHENTICATED` with `401` when no Supabase session access token
  is available.
- In production, `FASTAPI_BASE_URL` and `NEXUS_INTERNAL_SECRET` are required.
  Requests fail with a structured `E_INTERNAL` response if either is missing.
- Incoming request IDs are accepted only when they match the production request
  ID grammar; otherwise the BFF generates a fresh ID.

## Key Decisions

- Hard cutover: no legacy cookie-presence fallback and no Render-era backend
  fallback.
- `supabase.auth.getUser()` is used for protected page verification because it
  validates with Supabase Auth instead of trusting local cookie state.
- `supabase.auth.getSession()` is acceptable inside the BFF only for access-token
  extraction because FastAPI validates the JWT before injecting a viewer.
- Middleware stays lightweight and route-aware; protected route layouts provide
  the authoritative page-render gate.
- `/terms` and `/privacy` are explicitly public because the login page links to
  them and legal pages must not require a session.

## Acceptance Criteria

- Anonymous `GET /libraries` redirects to `/login?next=%2Flibraries`.
- Anonymous `GET /browse?x=1` redirects to `/login?next=%2Fbrowse%3Fx%3D1`.
- Anonymous `GET /terms` and `GET /privacy` return page content, not login.
- Anonymous `GET /api/libraries` returns JSON `401 E_UNAUTHENTICATED`, not HTML.
- A request with a fake or stale Supabase auth cookie does not render protected
  application UI.
- A transient Supabase Auth failure during protected page verification does not
  render protected application UI.
- A valid Supabase session renders the protected app shell and can make BFF API
  calls.
- Production BFF requests fail clearly if `FASTAPI_BASE_URL` or
  `NEXUS_INTERNAL_SECRET` is missing.
- BFF forwarding strips browser cookies, browser authorization, and spoofed
  internal headers.
- FastAPI receives only the server-derived bearer token, server internal secret,
  and validated request ID.

## Non-Goals

- No public guest mode for app or oracle routes.
- No anonymous read-only `/libraries`, `/browse`, or oracle access.
- No client-side-only auth gating for protected pages.
- No automatic backend failover to Render.
- No attempt to bypass Supabase Auth during an Auth outage.

## Files

- `docs/auth-production-cutover.md`: this contract.
- `apps/web/src/lib/supabase/middleware.ts`: route classification and cookie
  refresh.
- `apps/web/src/lib/auth/protected.ts`: protected page verification.
- `apps/web/src/app/(authenticated)/layout.tsx`: server gate for main app routes.
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`: client app shell.
- `apps/web/src/app/(oracle)/layout.tsx`: server gate for oracle routes.
- `apps/web/src/lib/api/proxy.ts`: BFF transport and production config checks.
- `apps/web/src/lib/supabase/middleware.test.ts`: middleware route contract.
- `apps/web/src/lib/auth/protected.test.tsx`: protected server gate contract.
- `apps/web/src/lib/api/proxy.test.ts`: BFF hardening contract.
