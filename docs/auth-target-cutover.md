# Auth Target Cutover

## Purpose

This document defines the target-state authentication and session architecture for
Nexus web and the Android shell. It supersedes the deleted
`docs/auth-production-cutover.md` (recoverable at `git show
451b11e~1:docs/auth-production-cutover.md`).

The production cutover made auth deterministic at the request boundary and removed
the blocking auth work that caused a Vercel `MIDDLEWARE_INVOCATION_TIMEOUT`. It did
not give the session any way to survive access-token expiry. There is no token
refresh path anywhere in the app: the Supabase refresh token sits unused in the
cookie, the ~1-hour access token is the hard ceiling on every session, and once it
expires the next request clears the cookie and redirects to `/login`. Every
returning user re-authenticates, on web and inside the Android WebView, on
effectively every cold open.

This cutover restores durable, silent sessions without ever reintroducing blocking
work into Edge middleware, and closes every item the production cutover left open.

It is a hard cutover. There is no interim mode where some users refresh and others
do not.

## Background

### Invariants carried over from the production cutover

These were correct and remain non-negotiable:

- Edge middleware performs no external auth work. It is a deterministic,
  network-free router. This is the fix for the original incident.
- Every protected surface fails closed.
- One shared cookie-boundary parser is the single interpreter of Supabase SSR
  cookies.
- Every auth network operation owns a single total deadline; per-fetch aborts are
  not sufficient.
- FastAPI verifies every bearer token and never passes an unauthenticated request.

### The scope error this cutover corrects

The production incident was specifically: *a blocking auth refresh inside Edge
middleware hangs the request until Vercel kills the 25-second invocation.* The
production cutover correctly removed refresh from middleware — and then removed it
from everywhere, and never built a non-blocking refresh path. Two different
statements were conflated:

- "No token refresh **during navigation / inside middleware**" — a latency and
  reliability invariant. Correct. Kept.
- "No token refresh **at all**" — a scope error. It turns the access-token TTL
  into the maximum session length and makes re-login the steady state for every
  returning user.

The fix is not to undo the production cutover. It is to add a refresh path that
lives **off** the Edge request path, in bounded route handlers — which the
incident contract never forbade.

### Open items from the production cutover, folded in here

This cutover also closes the production cutover's unfinished and incorrect items:

- `apps/web/src/lib/supabase/server.ts` was never given a total operation
  deadline; it still uses a per-fetch abort, the anti-pattern the prior doc's own
  key decision forbids.
- `apps/web/src/app/extension/connect/start/route.ts` was never listed by the
  prior doc; its FastAPI `fetch` has no deadline. It also carried a forbidden
  `getSession()` through the entire cutover, removed only later in `451b11e`.
- The promised production smoke-check script was never written.
- The promised "Vercel env sync validation fails on empty required values" test
  was never written.
- The FastAPI section forbade falling back to a shared JWT secret "unless
  production is explicitly configured to use that verifier mode" — a mode that
  does not exist.
- `SUPABASE_URL` and `API_PUBLIC_URL` were listed as required deploy vars but are
  read by no application code; `deployment.md` separately calls `SUPABASE_URL`
  legacy cleanup-only.
- `TEST_TOKEN_ISSUER` / `TEST_TOKEN_AUDIENCES` are dead config, advertised in
  `.env.example`, read by nothing, guarded by nothing.
- `apps/web/src/middleware.ts` regressed from a nonce-based CSP to
  `script-src 'self' 'unsafe-inline'`, with a stale "CSP headers with nonces"
  comment.
- FastAPI serves `/docs`, `/redoc`, and `/openapi.json` publicly in production.

## The Session Lifecycle

The production cutover modeled the session as a binary: a cookie is `valid` or
`invalid`. That binary is the defect. An access token that has expired while its
refresh token is still good is neither — and collapsing it into `invalid` is
exactly what forces re-login.

The session is a four-state lifecycle. Every component classifies into one of
these states and nothing else.

| State | Definition | Owner action |
|-------|------------|--------------|
| `anonymous` | No auth cookie, or a cookie that cannot be recovered (missing, malformed, non-bearer, bad config). | Protected request redirects to `/login`. |
| `active` | Auth cookie present; access token parses and is unexpired beyond the refresh margin. | Request proceeds. |
| `refreshable` | Auth cookie present; access token is expired or within the refresh margin; a non-empty `refresh_token` is present. | Silent refresh, then proceed. Never a logout. |
| `ended` | Refresh token absent, rejected, revoked, or a session limit was reached. | Clear cookies, redirect to `/login` with an explicit reason. |

The refresh margin is a fixed, named constant (target: 60 seconds). A token within
the margin is treated as `refreshable` so a request never races its own expiry.

`refreshable` is a first-class state. Treating it as `ended` is the bug this
cutover exists to fix. The classification is deliberately optimistic: a session
whose refresh token has been revoked still classifies as `refreshable` until the
refresh call fails and downgrades it to `ended`. That costs one wasted round-trip
on a dead session, which is correct and acceptable.

## Goals

- A returning user whose session has not been revoked is signed in silently —
  with no login screen — on web and inside the Android shell.
- Access-token expiry triggers a silent refresh, never a logout.
- No Edge middleware invocation performs network I/O. The original incident is
  structurally impossible, not merely avoided.
- Every auth network operation owns a single total deadline.
- Refresh is single-flight, bounded, and idempotent under concurrency. A
  refresh-token rotation race never logs a user out.
- Session end is deliberate and explained to the user: a session ends on signout
  or on revocation after a security event, never on an accidental token expiry.
  Idle and absolute caps are deferred (Pro-plan; see Session Policy).
- The browser holds no access or refresh tokens. The architecture conforms to the
  Backend-for-Frontend model.
- The authorization boundary is a server-side Data Access Layer, not middleware.
- Auth health is logged: every refresh failure and involuntary logout emits a
  structured log line — enough to debug a regression in a single-user app.
- Every item left open by the production cutover is closed.

## Non-Goals

- No token refresh inside Edge middleware. No network I/O of any kind in
  middleware.
- No access or refresh tokens in browser `localStorage`, `sessionStorage`, or any
  JavaScript-readable store.
- No native session or refresh-token store in the Android shell. It remains a thin
  WebView shell; the web session is the only session.
- No change to password handling or to the set of OAuth providers.
- No move off hosted Supabase Auth. The decision is to keep Supabase Auth managed;
  self-hosting GoTrue is recorded under Forward-Looking Work as a deferred option.
- The browser extension (`apps/extension/`) is out of scope. It is a third client
  with its own token lifecycle — extension-session and stream tokens, not the
  Supabase auth cookie. Its `/extension/connect/start` entry reads the web session
  cookie and so benefits from this cutover at the connect step, but the
  extension's own session lifecycle is not addressed here and may need a parallel
  review.
- Explicitly deferred to a future cutover, recorded under Forward-Looking Work so
  they are not rediscovered: Device Bound Session Credentials, passkey
  re-authentication, step-up auth for sensitive actions, DPoP or mTLS
  sender-constraining, and a full multi-device session-management UI.

## Request Classes

- Static and framework assets: bypass middleware work.
- Public pages: `/login`, `/terms`, `/privacy`, `/android`.
- Public well-known assets: `/.well-known/assetlinks.json`.
- Public auth routes: `/auth/callback`, `/auth/refresh`, `/auth/signout`.
- Public extension connect start: `/extension/connect/start`.
- BFF routes: `/api/*`. Middleware never redirects them; the BFF proxy handles
  refresh inline.
- Protected app pages: every page in `apps/web/src/app/(authenticated)`.
- Protected oracle pages: every page in `apps/web/src/app/(oracle)`.

## Target Behavior

- An anonymous request to a protected page redirects to
  `/login?next=<requested path and query>`.
- An anonymous request to a BFF route returns JSON `401 E_UNAUTHENTICATED`.
- An `active` request to a protected page renders.
- A `refreshable` request to a protected page is redirected once to
  `/auth/refresh`, refreshed, and lands on the originally requested page with no
  login screen and no flash.
- A `refreshable` request to a BFF route is refreshed inline by the proxy and
  returns the real response, carrying the rotated cookies.
- A request whose refresh succeeds never shows the user a login screen.
- A request whose refresh fails (`ended`) clears cookies and redirects to
  `/login?next=...`, and the login page states why the session ended.
- An expired access token whose session is still valid is never a logout on any
  surface.
- The Android shell behaves identically to web, because it hosts the same web
  session; a cold open after hours or days lands the user signed in.
- A session ends only on explicit signout or on revocation after a security
  event; when it does, the login page states why.
- Concurrent requests that all observe a `refreshable` cookie cause exactly one
  effective Supabase refresh; none of them logs the user out.
- No production request can produce `MIDDLEWARE_INVOCATION_TIMEOUT` from auth
  work.

## Architecture

### Asymmetric JWT signing keys

Confirmed: the production project (`nexus-prod`, ref `jiaozhsisiphjtomoamy`,
created 2026-03-13) already signs with an asymmetric ES256 key — its JWKS publishes
a single `EC` / `P-256` verification key, on a public endpoint (`HTTP 200`, no
`apikey` required). No migration is needed: the project was created after
Supabase's October 2025 asymmetric-by-default cutover, so there is no legacy HS256
signing secret and no transition window. FastAPI's `["RS256", "ES256"]` JWKS
verification (`python/nexus/auth/verifier.py`) is already correct for it.

Because tokens are already asymmetric, the protected page gate can verify an
access token locally — a WebCrypto signature check against the cached JWKS, no
Supabase Auth round-trip — via `getClaims()`. Moving the page gate from
`getUser()` to that local check is folded into the Data Access Layer in Phase 2;
there is no key migration to do first.

### Middleware — deterministic, network-free router

`apps/web/src/middleware.ts` and `apps/web/src/lib/supabase/middleware.ts` own only
local request classification, request-path forwarding, CSP headers, and redirect
decisions.

Rules:

- Do not import `@supabase/ssr`. Do not create a Supabase client.
- Do not call `getUser()`, `getClaims()`, `getSession()`, `refreshSession()`, or
  any SDK method, and do not `fetch`. No network I/O of any kind.
- Read the auth cookie through the boundary parser and classify it into one of the
  four lifecycle states.
- `active` protected page request: pass through with `x-nexus-request-path`.
- `refreshable` protected page request from a real navigation: redirect (`307`) to
  `/auth/refresh?next=<requested path and query>`. **Do not clear the cookie.** A
  prefetch request (identified by the `Next-Router-Prefetch` header) is never
  redirected to refresh — a hovered link must not drive a token refresh; let the
  prefetch pass and the page gate handles it on the real navigation.
- `ended` or `anonymous` protected page request: clear the auth cookie chunks and
  redirect to `/login?next=...`.
- `/api` and `/api/*`: pass through unchanged.
- The `refreshable` redirect is governed by an environment kill-switch. When the
  switch is off, middleware falls back to clearing the cookie and redirecting to
  `/login` — the pre-cutover behavior — so a broken refresh path can be
  neutralized without a redeploy.
- Emit the Content-Security-Policy header (see Content Security Policy).

Middleware classification remains an optimistic latency optimization, not an
authorization decision. The authorization decision is the Data Access Layer.

### Session Cookie Boundary parser

`apps/web/src/lib/auth/session-cookie.ts` remains the single parser of Supabase SSR
cookies. It is extended, not replaced.

Rules:

- Derive the cookie prefix from `NEXT_PUBLIC_SUPABASE_URL`; reconstruct chunked
  cookies in numeric order; accept only the current `base64-<base64url JSON>`
  shape.
- Parse `access_token`, `expires_at`, `token_type`, and additionally detect
  whether a non-empty `refresh_token` is present.
- Return a narrow lifecycle classification: `active`, `refreshable`, `ended`, or
  `anonymous`, plus a precise failure reason for tests and logging.
- A token that is expired, or within the refresh margin, with a non-empty
  `refresh_token` present, classifies as `refreshable`. The same expiry with no
  usable refresh token classifies as `ended`.
- Perform no network I/O. The parser reads `refresh_token` presence only to
  classify; it never itself performs a refresh.

This supersedes the production cutover's "Do not use `refresh_token`" rule, which
was the literal source of the binary model.

### The Refresh Route

`apps/web/src/app/auth/refresh/route.ts` is new. It is the only owner of
non-callback token refresh and cookie rotation. It runs on the Node.js runtime and
is a public route.

Rules:

- Handle `GET` for the browser-redirect flow (carries `next`) and `POST` for the
  proactive client flow.
- Build the `@supabase/ssr` route-handler client and perform exactly one bounded
  refresh, wrapped in a single total operation deadline (the budget pattern
  already in `apps/web/src/lib/supabase/route-handler.ts`).
- Be single-flight, and understand its limits. Dedupe concurrent refreshes within
  the process, keyed on the presented refresh token. In-process dedup only covers
  one serverless instance; on Vercel's many instances the real cross-instance
  safety net is Supabase's 10-second `refresh_token_reuse_interval`, within which
  re-presenting a just-rotated token returns the same new session instead of
  revoking it. This reliance is deliberate; no distributed lock is introduced. On
  a Supabase `Already Used` error, re-read cookies once and retry once.
- On success: write the rotated cookies; `GET` redirects (`307`) to the validated,
  same-origin `next`; `POST` returns `204` with the `Set-Cookie` headers.
- On failure: clear the auth cookie chunks; `GET` redirects to `/login?next=...`
  with a reason; `POST` returns `401`.
- Attempt refresh at most once. Never redirect into a state that re-evaluates as
  `refreshable`. Every path is terminal: the originally requested page, or
  `/login`. This is the redirect-loop guard.
- Send `Cache-Control: no-store`.
- Validate `next` with the existing redirect allowlist before using it.

### Protected Page Gate and Data Access Layer

Introduce a real Data Access Layer at `apps/web/src/lib/auth/dal.ts`, marked
`import "server-only"`. `apps/web/src/lib/auth/protected.ts` is folded into it.

Rules:

- Expose `verifySession()` and `getCurrentUser()`, each wrapped in React `cache()`
  so they are memoized per request and not threaded through props.
- `verifySession()` reads the cookie through the boundary parser. `active`:
  verify the access token locally via `getClaims()` within a total deadline, then
  return the viewer. `refreshable`: redirect to `/auth/refresh?next=...`. `ended`
  or `anonymous`: clear cookies and redirect to `/login?next=...`.
- Every protected page, every protected route handler, and every server action
  calls the DAL itself. A middleware or layout check does not protect them
  (CVE-2025-29927; partial rendering means layouts do not re-run on navigation).
- Authorization — resource ownership — is checked in the DAL, not only
  authentication.
- The DAL is the only module that performs verified session checks. It does not
  run on the client.

### BFF Proxy

`apps/web/src/lib/api/proxy.ts` remains transport-only and gains inline refresh.

Rules:

- Read the cookie through the boundary parser.
- `active`: forward as today.
- `refreshable`: perform an inline, bounded, single-flight refresh (the proxy is a
  Node route handler and may), set the rotated cookies on the response, then
  forward the request with the new access token. The browser receives the rotated
  cookies on the proxied response. Any response that carries a rotated
  `Set-Cookie` is sent `Cache-Control: no-store` — a cached `Set-Cookie` would
  hand one user another user's session.
- `ended` or `anonymous`: return JSON `401 E_UNAUTHENTICATED` and clear the cookie
  chunks.
- Forward only the server-read bearer token, the server-only internal secret, and
  a validated request ID. Never forward browser `Cookie`, `Authorization`, or
  `X-Nexus-Internal`.
- For state-changing methods, verify the request `Origin` against an allowlist
  (including the Android shell origin) before proxying. SameSite alone is not a
  complete CSRF defense.
- Every network call the proxy makes owns a total deadline.

### Proactive client refresh

A small client module refreshes the session before it can reach `refreshable`, so
the middleware-redirect and inline-refresh paths are reached only on genuine cold
loads.

Rules:

- On a timer, at roughly 50–75% of access-token life, `POST /auth/refresh`. Apply
  random jitter to the timer so multiple tabs — or web and the Android shell open
  at once — do not all refresh at the same wall-clock moment.
- On `document` `visibilitychange` to `visible`, `POST /auth/refresh`. This covers
  the Android-shell resume case, where background timers were frozen.
- Be single-flight on the client: never issue overlapping refresh requests. Stop
  the timer on signout.
- It is a plain credentialed `fetch`, not a Supabase client. There is exactly one
  refresher in the system — the server. Do not mount a long-lived browser Supabase
  client or enable client-side `autoRefreshToken`; a second refresher races the
  single-use refresh token for no benefit. The browser holds and sees no tokens.

### OAuth initiation, callback, and signout

- OAuth is initiated by a server route or server action calling
  `signInWithOAuth`, not by a browser Supabase client. Combined with httpOnly
  cookies, this means there is no browser Supabase client and the browser holds no
  tokens. This supersedes the `docs/rules/layers.md` allowance for browser
  Supabase auth calls; that rule is updated by this cutover.
- `/auth/callback` remains the only owner of OAuth code exchange and initial
  cookie writes, bounded by a total deadline.
- `/auth/signout` revokes the session server-side and clears the cookie chunks,
  bounded by a total deadline.
- None of these routes is protected by middleware or the page gate.

### FastAPI verification

- Verify every browser/BFF bearer token against JWKS before injecting a viewer.
  The project signs with ES256; the verifier's `["RS256", "ES256"]` JWKS allowlist
  already covers it, so no key-related change is required.
- Keep the bounded JWKS fetch, the named cache TTL, and fail-closed behavior when
  JWKS is unavailable and no cached key verifies.
- Remove the obsolete "shared JWT secret verifier mode" language: no such mode
  exists and none is added.
- Disable `/docs`, `/redoc`, and `/openapi.json` in production behind an
  environment flag; keep them in non-production. Do not proxy them through the
  BFF.

### Android WebView shell

The web fix fixes Android, because the shell hosts the same web session. The shell
also gains durability fixes.

Rules:

- `MainActivity` calls `CookieManager.getInstance().flush()` in `onPause()`, in
  addition to the existing `onPageFinished` flush, so a cookie rotated by a
  background refresh is persisted before the process can be killed.
- `MainActivity` calls `webView.onPause()` / `pauseTimers()` in `onPause()` and
  `webView.onResume()` / `resumeTimers()` in `onResume()`.
- Confirm the auth cookie carries a far-future `Max-Age` on both the callback and
  refresh `Set-Cookie`. A session-scoped cookie is discarded on Android cold
  start; a persistent cookie survives process death once flushed.
- The shell holds no native session and no native token store. OAuth continues to
  leave to a system browser via Custom Tabs and return through verified App Links.

### Content Security Policy

Restore a nonce-based CSP.

Rules:

- Generate a fresh nonce per request in middleware. Set it on both the request
  `x-nonce` header and the `Content-Security-Policy` header so Next.js applies it
  to framework and page scripts automatically.
- `script-src 'self' 'nonce-<nonce>' 'strict-dynamic'`. `'unsafe-eval'` is
  permitted only in development. Remove `'unsafe-inline'` from `script-src`.
- Remove the stale "CSP headers with nonces" comment and the regression `TODO`.
- The `E2E_DISABLE_CSP` escape hatch is retained and documented.

### Cookies

- The Supabase auth cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
  `Lax` is required so the cookie is sent on the top-level OAuth callback
  redirect. `HttpOnly` is feasible because no browser Supabase client exists.
- Apply `__Host-`-equivalent constraints where the Supabase SSR cookie name is
  configurable.
- Any response carrying a `Set-Cookie` for the auth cookie — `/auth/callback`,
  `/auth/refresh`, and BFF inline-refresh responses — is sent
  `Cache-Control: no-store`. A CDN or proxy caching a `Set-Cookie` would serve one
  user another user's session.
- Cookie chunking is unchanged.

### Deployment environment

- Required production env vars are exactly those read by code:
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `FASTAPI_BASE_URL`,
  `NEXUS_INTERNAL_SECRET`, `SUPABASE_ISSUER`, `SUPABASE_JWKS_URL`,
  `SUPABASE_AUDIENCES`, `APP_PUBLIC_URL`. `SUPABASE_URL` and `API_PUBLIC_URL` are
  removed from the required-deploy list.
- The env-sync scripts verify pulled production values are non-empty and print
  only names, never values.
- `TEST_TOKEN_ISSUER` / `TEST_TOKEN_AUDIENCES` are removed, or kept only with an
  explicit staging/production rejection guard.

## Session Policy

Session length is a deliberate, considered policy, not an accident of the
access-token TTL.

- Access token (`jwt_expiry`): keep at approximately 1 hour. Short access tokens
  are correct; Supabase discourages values under 2 minutes.
- Refresh-token rotation: enabled. `refresh_token_reuse_interval`: 10 seconds.
- Inactivity (idle) timeout and absolute time-box: **not enabled.** Supabase gates
  both behind the Pro plan. For a single-user personal app the decision is to stay
  on the free tier and accept an effectively unbounded session: an active or idle
  user stays signed in as long as the refresh token keeps rotating. The session is
  still ended explicitly — by signout, and by revocation on a security event such
  as a password or OAuth-credential change. If the app ever becomes multi-user,
  revisit and enable a sliding idle timeout (~30 days) and an absolute cap
  (~6 months).
- A forced logout — revocation or signout — lands the user on `/login` with a
  plain, specific reason. Avoid an opaque "session expired".

## Observability

The production cutover shipped no auth telemetry, which is part of why the
re-login behavior went undiagnosed. This cutover adds enough to debug a regression,
right-sized for a single-user app — logs, not a metrics pipeline.

- Emit a structured log line on every refresh failure, carrying the failure
  reason (the `ended` cause, the Supabase error, or a timeout). This is the
  primary regression signal and the minimum bar.
- Emit a structured log line on every involuntary logout — an `ended` transition
  that did not pass through explicit signout.
- Log, do not dashboard. No service-level indicators, no alerting infrastructure.
  If the app ever becomes multi-user, promote these log lines to metrics
  (involuntary-logout rate, refresh success rate, refresh latency) and alert on
  the involuntary-logout rate.

## Key Decisions

- The session is a four-state lifecycle (`anonymous`, `active`, `refreshable`,
  `ended`), not a binary. `refreshable` is a first-class state. The binary model
  was the root defect.
- Middleware never performs network I/O. Refresh happens in bounded route
  handlers. "No refresh during navigation" was always a constraint on *blocking
  middleware*, not a ban on refresh; a redirect to a bounded route handler honors
  it while restoring durable sessions.
- Refresh lives at three named choke points — the refresh route, the BFF proxy,
  and the DAL — and is single-flight, bounded, and idempotent everywhere.
  Cross-instance correctness rests deliberately on Supabase's 10-second
  refresh-token reuse window, not on a distributed lock.
- Asymmetric JWTs make access-token verification local. The page gate stops
  calling Supabase Auth on every navigation.
- The browser holds no tokens. The auth cookie is `HttpOnly`; OAuth is
  server-initiated. This is the Backend-for-Frontend model.
- The Data Access Layer, not middleware, is the authorization boundary.
- Session length is unbounded by deliberate choice: idle and absolute caps are
  Pro-plan features and are not enabled for this single-user app. A session ends
  on signout or revocation.
- Auth health is logged, not dashboarded — structured lines on refresh failure
  and involuntary logout, sized for a single-user app.
- This document is a living contract. Per the repository cleanliness rules a
  finished cutover doc is removed — but only after every Acceptance Criterion is
  met, and its durable rules are first migrated into `docs/rules/`. The production
  cutover was deleted as "finished" with two acceptance criteria unmet and its
  rules un-migrated; this cutover does not repeat that.

## Forward-Looking Work

Recorded so it is not rediscovered. Not in this cutover:

- Self-hosting GoTrue (`supabase/auth`) on the Hetzner VPS, to remove the last
  managed dependency. Low-code — the same JWT/JWKS/refresh model and
  `@supabase/ssr` libraries — but it adds auth ops, and an auth outage is a total
  lockout. Deferred deliberately; revisit only if the single-vendor concern
  outweighs zero-ops hosting. If pursued, verify the OSS GoTrue build supports
  asymmetric signing keys and any session controls relied on.
- Device Bound Session Credentials: hardware-bound session cookies (TPM / Secure
  Enclave), the current state of the art against cookie theft, now shipping in
  Chrome. Adopting it requires registration and refresh endpoints; revisit once
  the refresh route exists.
- Passkey re-authentication and step-up auth for sensitive actions.
- DPoP or mTLS sender-constraining. For a cookie-BFF web app, refresh-token
  rotation already satisfies the OAuth Security BCP; mTLS on the internal
  BFF-to-FastAPI hop is the only piece worth considering, as defense in depth.
- A full self-service multi-device session-management UI ("active devices",
  per-session revoke). Basic signout and server-side revoke ship in this cutover;
  the management surface does not.

## Implementation Plan

### Phase 1 — Restore the session

1. JWT signing-key mode is confirmed asymmetric (ES256); no migration is needed
   (see Asymmetric JWT Signing Keys). Confirm `@supabase/ssr` is on a current
   release (>= 0.10.x); several refresh and chunked-cookie bugs were fixed there.
2. Extend the boundary parser with the four-state lifecycle classification,
   including `refreshable`.
3. Add the `/auth/refresh` route handler: bounded, single-flight, terminal,
   handling `GET` and `POST`, behind the redirect kill-switch flag.
4. Update middleware to redirect `refreshable` real-navigation page requests to
   `/auth/refresh` without clearing the cookie, leave prefetch requests alone, and
   keep clearing only `ended`/`anonymous` cookies.
5. Update the BFF proxy to perform inline single-flight refresh on `refreshable`.
6. Add the proactive client refresh module (jittered timer plus
   `visibilitychange`); do not add a browser Supabase client.

### Phase 2 — Harden

7. Make the auth cookie `HttpOnly`; move OAuth initiation server-side; remove the
   browser Supabase client.
8. Introduce the `server-only` Data Access Layer; fold in `protected.ts`; switch
   the page gate to local `getClaims()` verification.
9. Restore nonce-based CSP with `strict-dynamic`.
10. Add the `Origin` allowlist check to state-changing BFF requests.
11. Give `apps/web/src/lib/supabase/server.ts` a total operation deadline.
12. Add a total deadline to the `extension/connect/start` FastAPI fetch.
13. Disable FastAPI `/docs`, `/redoc`, `/openapi.json` in production.

### Phase 3 — Policy and logging

14. Confirm the Session Policy decision — free tier, unbounded session, no idle or
    absolute caps — is recorded; no Supabase session-control configuration is
    performed.
15. Add structured logging for refresh failures and involuntary logouts.
16. Add the "you were signed out, here is why" login UX.

### Phase 4 — Android and cleanup

17. Add `onPause()` cookie flush and WebView pause/resume to `MainActivity`;
    confirm the auth cookie `Max-Age`.
18. Remove the obsolete shared-secret clause, the dead `SUPABASE_URL` /
    `API_PUBLIC_URL` required vars, and the dead `TEST_TOKEN_*` config.
19. Correct the stale "session refresh" line in `docs/rules/layers.md`.
20. Write the production smoke-check script and the Vercel env-sync validation
    test.

Each phase lands with its own tests. Phase 1 is independently shippable and ends
the re-login symptom on its own. Within Phase 1, steps 2-4 (parser, refresh route,
middleware) are one atomic change — the `refreshable` state must flow through all
three at once; steps 5 and 6 can follow as separate changes.

## Files

Web — auth boundary:

- `apps/web/src/middleware.ts`
- `apps/web/src/lib/supabase/middleware.ts`
- `apps/web/src/lib/auth/session-cookie.ts`
- `apps/web/src/lib/auth/protected.ts` (folded into the DAL)
- `apps/web/src/lib/auth/dal.ts` (new)
- `apps/web/src/lib/auth/redirects.ts`
- `apps/web/src/app/auth/refresh/route.ts` (new)
- `apps/web/src/app/auth/callback/route.ts`
- `apps/web/src/app/auth/signout/route.ts`
- `apps/web/src/lib/supabase/route-handler.ts`
- `apps/web/src/lib/supabase/server.ts`
- `apps/web/src/lib/supabase/client.ts` (removed once OAuth is server-initiated)
- `apps/web/src/lib/api/proxy.ts`
- `apps/web/src/app/extension/connect/start/route.ts`
- `apps/web/src/app/(authenticated)/layout.tsx`
- `apps/web/src/app/(oracle)/layout.tsx`
- `apps/web/src/app/login/LoginPageClient.tsx`
- proactive client refresh module (new)

Backend:

- `python/nexus/auth/verifier.py`
- `python/nexus/auth/middleware.py`
- `python/nexus/app.py` (docs URL gating)
- `python/nexus/config.py` (dead `TEST_TOKEN_*` settings)

Config, deploy, docs:

- `supabase/config.toml`
- `.env.example`
- `deploy/vercel/sync-env.sh`
- `deploy/hetzner/sync-env.sh`
- `deployment.md`
- `docs/rules/layers.md`
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt`
- `deploy/smoke/` (new — production smoke-check script)

## Test Plan

Frontend unit tests:

- Boundary parser classifies `active`, `refreshable`, `ended`, `anonymous`,
  including expired-with-refresh-token as `refreshable`, expired-without as
  `ended`, and the refresh-margin boundary.
- Middleware redirects `refreshable` page requests to `/auth/refresh` and does not
  clear the cookie.
- Middleware does not redirect a `refreshable` prefetch request to `/auth/refresh`.
- Middleware falls back to the pre-cutover clear-and-redirect behavior when the
  kill-switch is off.
- Middleware still clears and redirects `ended`/`anonymous` requests, passes
  `/api/*` through, and makes no network call on any path.
- `/auth/refresh` refreshes and redirects to `next` on success.
- `/auth/refresh` clears cookies and redirects to `/login` on failure.
- `/auth/refresh` attempts refresh at most once and cannot loop.
- `/auth/refresh` is single-flight: concurrent calls cause one Supabase refresh.
- `/auth/refresh` retries once on a Supabase `Already Used` error.
- BFF proxy performs inline refresh on `refreshable` and returns the real
  response with rotated cookies and `Cache-Control: no-store`.
- BFF proxy rejects state-changing requests from a disallowed `Origin`.
- DAL `verifySession()` verifies locally, redirects on `refreshable`/`ended`, and
  is memoized per request.
- Vercel env-sync validation fails on empty required values.

Backend tests:

- JWT verifier uses cached JWKS within TTL, bounds the JWKS fetch, and fails
  closed when JWKS is unavailable and no cached key verifies.
- ES256 and RS256 tokens both verify during migration.
- `/docs`, `/redoc`, `/openapi.json` are unavailable when the production flag is
  set.

End-to-end tests:

- A user whose access token has expired but whose session is valid loads a
  protected page and is signed in with no login screen.
- The same, for a BFF API call.
- A user with a revoked refresh token is sent to `/login` with a reason.
- The incident reproduction: a valid-shaped expired cookie produces a prompt
  redirect, never a hang.
- Concurrent requests on a `refreshable` cookie do not log the user out.
- Android, instrumented: a cold open after access-token expiry lands signed in.

End-to-end tests run against a shortened `jwt_expiry` so an access token expires
within the test. Because a too-short expiry can pass a test while masking a real
timing bug, the cutover is not accepted on automated tests alone: a manual
real-elapsed check — let an hour pass idle, then cold-open the app on web and in
the Android shell — is required and is an Acceptance Criterion.

Production smoke checks — committed as a script in `deploy/smoke/` and run in the
release pipeline, not described and forgotten:

- Anonymous protected page: prompt `307` to `/login` with preserved `next`.
- Valid-shaped expired cookie on a protected page: prompt redirect, no timeout.
- Public pages return `200`.
- Anonymous and expired-cookie BFF routes return JSON `401 E_UNAUTHENTICATED`.
- `/docs` is not reachable in production.
- The API health endpoint returns `200`.

## Acceptance Criteria

- A returning user with a non-revoked session is signed in silently on web and in
  the Android shell.
- Access-token expiry never produces a login screen for a session that is still
  valid.
- No production request can produce `MIDDLEWARE_INVOCATION_TIMEOUT` from auth
  work, and no middleware code path performs network I/O.
- Concurrent refreshes never log a user out.
- The browser exposes no access or refresh token to JavaScript.
- The four-state lifecycle is implemented in one parser and consumed identically
  by middleware, the DAL, the refresh route, and the BFF.
- Every open item from the production cutover listed in Background is closed.
- Refresh failures and involuntary logouts emit structured log lines.
- All changed behavior is covered by the tests above, and the production
  smoke-check script exists in `deploy/smoke/` and runs in the release pipeline.
- The fix is verified by a manual real-elapsed test — over an hour idle, then a
  cold open — on web and in the Android shell, not by shortened-TTL tests alone.
- This document is not deleted or marked complete until every criterion above is
  verified and its durable rules have been migrated into `docs/rules/`.

## References

1. RFC 9700 — OAuth 2.0 Security Best Current Practice.
   https://www.rfc-editor.org/rfc/rfc9700.html
2. RFC 8252 — OAuth 2.0 for Native Apps.
   https://www.rfc-editor.org/rfc/rfc8252.html
3. IETF draft — OAuth 2.0 for Browser-Based Apps (the BFF pattern).
   https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps
4. Supabase — User sessions (rotation, reuse interval, time-box, inactivity).
   https://supabase.com/docs/guides/auth/sessions
5. Supabase — Server-side auth for Next.js.
   https://supabase.com/docs/guides/auth/server-side/nextjs
6. Supabase — `getClaims()` reference (local verification with asymmetric keys).
   https://supabase.com/docs/reference/javascript/auth-getclaims
7. Supabase — JWT signing keys (asymmetric migration).
   https://supabase.com/blog/jwt-signing-keys
8. supabase/supabase #30241 — Stop using Next.js middleware to refresh tokens.
   https://github.com/supabase/supabase/issues/30241
9. Next.js — Authentication guide (the Data Access Layer pattern).
   https://nextjs.org/docs/app/guides/authentication
10. Next.js — Content Security Policy (nonce + `strict-dynamic`).
    https://nextjs.org/docs/app/guides/content-security-policy
11. Vercel — `MIDDLEWARE_INVOCATION_TIMEOUT` and the 25-second Edge budget.
    https://vercel.com/docs/errors/MIDDLEWARE_INVOCATION_TIMEOUT
12. Vercel — Postmortem on the Next.js middleware bypass (CVE-2025-29927).
    https://vercel.com/blog/postmortem-on-next-js-middleware-bypass
13. OWASP — Session Management Cheat Sheet (idle vs absolute timeouts).
    https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
14. Auth0 — Refresh token rotation and reuse detection.
    https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
15. Clerk — How session tokens work (short token plus refresh design).
    https://clerk.com/blog/how-we-roll-sessions
16. Chrome — Device Bound Session Credentials (forward-looking).
    https://developer.chrome.com/docs/web-platform/device-bound-session-credentials
