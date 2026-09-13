# Auth Session Recovery Hard Cutover

**Status:** APPROVED SPEC · 2026-08-07

**Questions:** None.

**Type:** hard cut. Delete `/auth/refresh` and every producer, consumer, test,
and comment for it. No alias, compatibility redirect, feature flag, fallback
parser, dual behavior, or legacy response shape.

## Decision

Replace redirect-driven refresh with one session-resolution capability:

- `GET /auth/session/recover` is a public, non-mutating recovery surface.
- `POST /auth/session/resolve` is the sole browser session-resolution endpoint.
- Pages enter recovery; APIs and mutations resolve inline. No mutation is ever
  redirected.
- One response finalizer owns rotated/cleared cookies and private no-store
  headers on every outcome, including downstream failure.
- Provider uncertainty preserves credentials. Only exact terminal auth outcomes
  clear them.
- Delete periodic/visibility refresh. Sessions resolve only when a real page,
  API, or mutation needs them.

This is the 80/20 gold standard for the one-user prototype. It fixes every
proven correctness failure without a session database, distributed lock, new
auth provider, or generic workflow system.

## Goals

1. Every auth navigation converges; no route can repeat in one recovery flow.
2. A valid session survives network, JWKS, Supabase, FastAPI, and cookie-write
   interruptions.
3. `401 E_UNAUTHENTICATED` means terminal session loss only.
4. Session mutation occurs only in a response-owning Route Handler/BFF edge.
5. Successful refresh always delivers one valid successor cookie set.
6. All cookie-dependent responses are uncacheable by shared caches.
7. Production release proves the provider contract and live recovery contract.

## Non-goals

- Opaque/database-backed sessions, token encryption, central revocation, or a
  custom auth server.
- Redis, durable leases, distributed locks, cross-provider transactions, or
  multi-region coordination.
- DPoP, passkeys, MFA, provider migration, or session-policy redesign.
- Android OAuth callback/App-Link redesign; that is a separate security cutover.
- Full offline authentication, service-worker auth, background login, or
  automatic destructive repair.
- A telemetry platform, auth dashboard, generalized retry framework, or broad
  release-system redesign.

## Governing rules

All `docs/rules` apply. In particular:

- finite outcomes are exhaustive tagged unions;
- provider payloads are classified once at the adapter boundary;
- expected terminal auth failures are values; unknown states are defects;
- transient dependency errors are preserved as typed adapter errors and become
  transport `503`, never fake auth-domain state;
- raw cookies/tokens never enter logs, errors, map keys, URLs, or evidence;
- tests assert HTTP/navigation/cookie behavior, not internal calls;
- this cutover deletes superseded paths instead of retaining shims.

## Target behavior

| Input | Page navigation | API/mutation | Cookie action |
| --- | --- | --- | --- |
| verified active session | render target | continue | preserve |
| refreshable session | recovery surface resolves, then replaces target | refresh inline, then continue | rotate |
| terminal/revoked/corrupt session | recovery resolves once, then login | `401 E_UNAUTHENTICATED` | clear |
| missing session | login | `401 E_UNAUTHENTICATED` | none |
| provider/JWKS/network unavailable | recovery shows Retry | `503 E_AUTH_UNAVAILABLE` | preserve |
| invariant/provider-contract defect | normal defect boundary | `500 E_INTERNAL` | preserve |

The recovery surface initially says **Restoring your session…**. On `503` it
shows one calm explanation and **Retry**. On `401` it replaces history with the
validated login URL. It never offers Clear data/cookies. Success replaces
history with `next`, so Back cannot re-enter recovery.

## Final architecture

```text
untrusted Supabase cookie
  -> session-cookie parser                 (shape only; no I/O)
  -> session verifier / refresh adapter    (one provider owner)
  -> exhaustive session outcome
     -> Server Component page gate         (read/redirect only)
     -> POST session resolver              (browser response owner)
     -> BFF / mutation adapter              (inline response owner)
  -> session response finalizer             (cookies + cache policy)
```

The parser remains `active | refreshable | ended | anonymous`; `active` never
means authenticated until verification succeeds. Middleware may classify but
may not claim verification.

## Capability contract

```ts
type SessionVerification =
  | { kind: "Verified"; viewer: Viewer }
  | { kind: "RefreshRequired" }
  | { kind: "SessionEnded"; cookieNames: readonly string[] }
  | { kind: "Anonymous" };

type SessionRefreshOutcome =
  | { kind: "Refreshed"; cookiesToSet: NonEmptyCookieSet }
  | { kind: "SessionEnded"; cookieNames: readonly string[] };

type SessionEffect =
  | { kind: "Preserve" }
  | { kind: "Rotate"; cookiesToSet: NonEmptyCookieSet }
  | { kind: "Clear"; cookieNames: readonly string[]; feedback: boolean };
```

`AuthDependencyError` is the named, expected adapter error for timeout, network
failure, provider `5xx`/`429`, `request_timeout`, and `conflict`. It is not a
union member and never becomes `SessionEnded`. Unknown provider codes, a
successful refresh without cookies, or rotated cookies that do not parse as
active are defects.

Exact refresh-terminal codes are `validation_failed` (only for this internal
refresh-grant call when the presented refresh credential is invalid),
`refresh_token_not_found`,
`refresh_token_already_used`, `session_not_found`, `session_expired`, and
`user_not_found`/`user_banned`. Use provider `error.code`/`error.name`; never
message text.
Remove the retry for `refresh_token_already_used`: Supabase defines it as
outside reuse recovery. Keep process-local single-flight, keyed by a SHA-256
digest of the presented cookie, never the raw cookie. No distributed lock.

An active-shaped access token that fails cryptographic verification is never
trusted. If its cookie still carries a refresh token, classify it
`RefreshRequired` and let the provider prove or reject that independent
credential; otherwise classify it `SessionEnded`. Verification timeout does not
trigger refresh and preserves the cookie.

## HTTP/API design

| Endpoint | Method | Contract |
| --- | --- | --- |
| `/auth/session/recover?next=<target>` | GET | public, `200`, private no-store; renders recovery client; no provider call or cookie mutation |
| `/auth/session/resolve` | POST | exact same-origin plus fixed `X-Nexus-Session: Resolve`; `204`, `401`, or `503`; no redirect |

`POST /auth/session/resolve`:

- `204`: session was already verified or was refreshed; rotated cookies are on
  the response when applicable;
- `401`: session is absent or terminal; terminal cookies are cleared and set the
  existing short-lived feedback marker, while ordinary absence does neither;
- `503`: dependency unavailable; credentials are byte-for-byte preserved and
  `Retry-After: 3` is returned;
- `500`: defect boundary; credentials are preserved.

The endpoint has no response body and accepts no token, cookie name, provider,
redirect, or target in its body. `next` stays solely on the GET recovery URL and
uses the existing `AuthReturnTarget` parser.

Every session-dependent route-handler, BFF, and mutation response uses:

```text
Cache-Control: private, no-store
Pragma: no-cache
Expires: 0
Vary: Cookie
```

Rendered App Router HTML pages are the one framework-owned exception: Next.js
appends its RSC `Vary` dimensions while rendering and owns that final header.
Those pages still carry the canonical `private, no-store` policy, which is the
cache-safety requirement; direct route-handler/BFF responses keep `Vary:
Cookie` explicitly.

Static/public assets retain their existing cache policy.

## Intra-system composition

### Protected page

```text
middleware passes active/refreshable GET
  -> DAL verifies
  -> Verified: render
  -> RefreshRequired / SessionEnded / AuthDependencyError:
       redirect once to /auth/session/recover?next=...
  -> recovery client POSTs /auth/session/resolve
  -> 204 target | 401 login | 503 Retry
```

Middleware redirects only safe page requests. It never sends POST/PUT/PATCH/
DELETE or a Server Action to an auth route. `/login` never redirects from cookie
shape to a protected target; active/refreshable shape enters recovery, and
terminal/malformed cookies are cleared by a response owner.

### BFF and mutations

- Resolve refreshable sessions inline before consuming request bodies or
  applying domain mutations.
- Preserve and finalize the `SessionEffect` on every return path.
- If refresh succeeds and FastAPI later returns/throws `499`, `5xx`, timeout, or
  malformed data, the response still carries successor cookies.
- A trusted FastAPI `401` is terminal: clear the current/successor cookie names
  and return `401 E_UNAUTHENTICATED`.
- Auth dependency failure returns `503 E_AUTH_UNAVAILABLE`; the global
  unauthenticated boundary responds only to terminal 401.
- All authenticated BFF responses are private no-store. Public proxy lanes are
  unchanged.

Password update reuses these outcomes/finalizer; its bespoke
`failed.reason === timeout` projection is deleted.

### Android shell

- Native BFF cookie installation awaits every `CookieManager.setCookie`
  completion before `flush()` and before the native request completes.
- Main-frame `ERROR_REDIRECT_LOOP` stops navigation and enters the canonical
  recovery URL exactly once. A second failure renders one native terminal
  surface with **Retry**; it never clears WebView data or cookies.
- Successful non-auth navigation resets the circuit breaker.
- `onResume()` remains lifecycle-only and never navigates.

## Response finalizer

Add one `finalizeSessionResponse(response, effect)` owner. It:

1. applies exactly one `SessionEffect`;
2. emits all successor cookies or all requested expirations;
3. applies the canonical private no-store headers last, overriding upstream
   cache headers;
4. never throws away effects when wrapping an error response.

Reuse `clearSupabaseAuthCookies`, `getSupabaseAuthCookieNames`, `noStore`, the
cookie parser, return-target parser, and route-handler cookie adapter. Delete
`rotated-cookies.ts`; direct cookie loops outside the finalizer are forbidden.

## Observability

Emit one redacted event per logical resolution, not per redirect:

```text
Auth.Session.Resolve
nexus.auth.trigger = Page | Api | Mutation | AndroidRecovery
nexus.auth.outcome = Verified | Refreshed | Ended | Anonymous | Unavailable | Defect
nexus.auth.provider_code = <allowlisted code only>
nexus.auth.duration_ms = <bounded number>
nexus.auth.single_flight = Owner | Joiner
```

Never log cookie/token values, cookie digests, URLs with auth parameters,
handoff values, user IDs, or emails. No new telemetry vendor or datastore.

## Production and release contract

- Extend hosted config verification to require refresh rotation enabled and
  reuse interval exactly `10` seconds.
- Run config verification before release mutation.
- Make live auth smoke part of durable `finalize` public proof after the exact
  production alias is bound and before publication succeeds. Failure follows
  the existing forward-fix state machine.
- Live smoke must prove exact recovery locations, bounded invalid-cookie
  convergence, terminal clearing, BFF outcome codes, private no-store headers,
  OAuth callback/project identity, and stale project-cookie rejection. CI
  boundary tests own unavailable-provider and downstream-failure injection.
- A generic redirect or generic 401 is not sufficient proof.

No database schema, migration, environment variable, persistent session state,
or release-record field is added.

## File plan

Create:

- `apps/web/src/lib/auth/session-response.ts`
- `apps/web/src/app/auth/session/recover/page.tsx`
- `apps/web/src/app/auth/session/recover/SessionRecovery.tsx`
- `apps/web/src/app/auth/session/resolve/route.ts`
- behavior tests adjacent to the new boundary and in the existing auth journey

Modify:

- `apps/web/src/lib/auth/{refresh,dal,redirects,no-store}.ts*`
- `apps/web/src/lib/auth/session-cookie.ts`
- `apps/web/src/lib/api/proxy.ts`
- `apps/web/src/lib/supabase/middleware.ts`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/auth/password/update/route.ts`
- `apps/web/src/middleware.ts`
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt`
- `apps/android/app/src/main/java/app/nexus/android/playback/NexusOriginClient.kt`
- existing Android unit/instrumentation tests
- `deploy/supabase/verify-auth-config.sh`
- `deploy/smoke/auth-smoke.sh`
- `deploy/hetzner/{deploy.sh,release.py}` only where required to compose proof
- existing verifier/release tests, `docs/architecture.md`, `deployment.md`, and
  `android-testing.md`

Delete:

- `apps/web/src/app/auth/refresh/route.ts`
- `apps/web/src/lib/auth/rotated-cookies.ts`
- `apps/web/src/lib/auth/SessionRefresher.tsx` and its shell mount
- `buildAuthRefreshUrl` and all `/auth/refresh` builders/callers
- the DAL Server-Component cookie mutation/catch
- middleware's refresh redirect and prefetch-refresh branch
- the `refresh_token_already_used` retry
- superseded tests/comments that assert shape-active means authenticated,
  generic redirect success, generic expired-cookie 401, or direct cookie loops

Do not introduce a second parser, cookie writer, retry loop, response finalizer,
auth error decoder, or Android recovery state machine.

## Acceptance criteria

1. A future-expiry invalid cookie reaches a clean login in at most one recovery
   POST; no URL repeats and the auth cookie is expired.
2. Verification timeout and refresh network/`5xx`/`429`/`conflict` return `503`,
   preserve credentials, and render Retry without login navigation.
3. Terminal refresh codes return `401`, clear every direct/chunk cookie, and
   show session-ended feedback once.
4. Refresh success with zero, malformed, or non-active successor cookies
   defects and never redirects as success.
5. Refresh success followed by FastAPI timeout/`502`/`504` still returns every
   successor cookie and private no-store headers.
6. No non-GET request receives an auth redirect or loses its body to recovery.
7. The unauthenticated client boundary redirects only for terminal
   `401 E_UNAUTHENTICATED`, never 503/500.
8. All session-dependent page, auth, and BFF outcomes carry the canonical
   no-store headers; route-handler/BFF outcomes also carry `Vary: Cookie`, and
   rendered pages carry Next's framework RSC `Vary`; static/public assets are
   unchanged.
9. Concurrent same-cookie refreshes make one in-process provider call and every
   waiter receives the same successor set; no raw cookie is retained as a key.
10. Android waits for cookie installation, survives hot/cold exact App Links,
    and terminates an injected redirect loop without clearing app data.
11. Hosted config and post-alias auth smoke are mandatory release gates.
12. `rg '/auth/refresh|buildAuthRefreshUrl|refresh_token_already_used.*retry'`
    finds no live code, tests, runbooks, or architecture contract.
13. Focused web, real-stack auth E2E, Android shell, verifier, release-kernel,
    and full repository gates pass.

## Cutover sequence

1. Write failing boundary/E2E tests from the acceptance criteria.
2. Add the resolver, recovery surface, typed provider outcomes, and finalizer.
3. Switch DAL, middleware, login, BFF, and mutations in one change; delete both
   proactive refresh and `/auth/refresh` immediately.
4. Add Android cookie acknowledgement and circuit breaking.
5. Strengthen hosted verification and durable release smoke.
6. Delete superseded code/tests/docs, update canonical architecture/runbooks,
   and run the full gates.

There is no mixed deployment mode. Web, Android, smoke, and release proof ship
from one source SHA.
