# Auth return target hard cutover

## Status

Spec drafted on 2026-06-05. Implemented in the worktree on 2026-06-05.

Local web verification completed:

- `cd apps/web && bun run typecheck`
- focused unit auth/source-shape bundle
- focused browser auth-boundary/login/settings bundle
- auth smoke-script syntax and `make -n smoke-auth-redirects`

Android local verification remains environment-blocked in this worktree:
`./gradlew :app:testDebugUnitTest -PnexusGoogleWebClientId=test-web-client-id`
requires an Android SDK location (`ANDROID_HOME` or `apps/android/local.properties`).

This is a hard-cutover plan. It does not preserve legacy auth-return URL
builders, duplicate password sign-in APIs, route-local `next` setters, ad hoc
path checks, or transport-layer login redirects.

## Summary

Auth return intent is valid and necessary: a user who is sent to login from a
protected page should land back on the originally requested in-app destination
after a successful login, refresh, OAuth callback, or native handoff.

The pre-cutover implementation had the right high-level shape, but was not yet
a strict production contract:

- `normalizeAuthRedirect()` can parse a hostile path into a protocol-relative
  URL after normalization.
- `/libraries` is duplicated as both the auth default and the workspace default.
- Default return intent is overexposed as `?next=%2Flibraries` in common
  user-visible URLs.
- `apiFetch()` owns a login-navigation side effect inside the HTTP transport
  adapter.
- `signInWithPasswordAction` and `signUpWithPasswordAction` are dead parallel
  APIs for a capability now owned by `POST /auth/password`.
- Several auth route helpers set `next`, 307/303 statuses, `no-store`, and
  session-ended feedback in repeated local patterns.
- Deploy proof for hosted Supabase redirect provider state exists, but is not
  part of the narrow `make smoke` lane.

The target state is one auth-return-target capability with one parser, one
default app-home route constant, one URL-construction surface, one client-side
unauthenticated navigation owner, and one deployed verification lane.

## Implementation result

- `apps/web/src/lib/auth/redirects.ts` owns the branded `AuthReturnTarget`, the
  default target, post-parse local-target validation, default `next`
  suppression, and every auth URL builder.
- `apps/web/src/lib/routes/defaults.ts` owns the authenticated app-home route;
  auth, workspace, and the root redirect derive from it.
- `apps/web/src/lib/api/client.ts` is pure transport parsing. It throws
  structured `ApiError` values and does not navigate.
- `apps/web/src/lib/auth/UnauthenticatedApiBoundary.tsx` owns client-side
  navigation for caught and uncaught `401 E_UNAUTHENTICATED` API failures.
- `POST /auth/password` is the only password sign-in/create capability.
  Dead password sign-in/sign-up server actions were deleted.
- Android defaults missing native `next` to the same authenticated app home and
  does not own product API or auth-return parsing.
- `make smoke-auth-redirects` is the auth redirect/provider release lane.

## Why

The `?next=` concept is not inherently messy. It is a standard return-target
pattern for auth flows. What matters is whether the target is validated,
canonicalized once, carried only where needed, and consumed by a small number of
known redirect sinks.

The current implementation violates that bar in one security-critical way:

```ts
normalizeAuthRedirect("/..//evil.example") // currently yields "//evil.example"
new URL("//evil.example", "https://app.example.com").href
// "https://evil.example/"
```

The raw input does not start with `//`, so it passes the pre-parse guard. The URL
parser then resolves dot segments and produces a pathname that starts with
`//`. The helper returns that post-parse value without rechecking the invariant.
Every redirect sink that calls `new URL(nextPath, origin)` is then exposed to an
open redirect.

A subject matter expert would not fix this by patching individual route
handlers. The fix belongs at the auth-return-target owner and then every caller
must consume the owned value.

## Standards posture

External guidance:

- OWASP Unvalidated Redirects and Forwards: redirect targets derived from
  request input must be constrained to approved local targets.
- Next.js redirecting model: pre-render conditional redirects belong in
  middleware/proxy, route handlers, or server redirects, depending on the phase.

Repo rules:

- `docs/rules/cleanliness.md`: one concern, one owner; collapse duplicate
  validators and mutation flows.
- `docs/rules/cleanliness.md`: expose each capability in one primary form.
- `docs/rules/correctness.md`: parse and validate untrusted data once at
  ingress; after the boundary, treat values as canonical.
- `docs/rules/layers.md`: middleware classifies sessions and gates pages; DAL is
  the verified-session boundary; BFF routes and API clients do not own business
  policy.
- `docs/local-rules/testing_standards.md`: auth/session behavior needs real-stack E2E
  coverage where framework routing matters.

## Pre-cutover behavior map

### Auth return producers

- `apps/web/src/lib/supabase/middleware.ts`
  - Protected anonymous or ended page navigation redirects to `/login?next=...`.
  - Refreshable page navigation redirects to `/auth/refresh?next=...`.
  - Authenticated `/login?next=...` redirects away to the normalized target.
- `apps/web/src/lib/auth/dal.ts`
  - Server-component backstop redirects to `/login?next=...` or
    `/auth/refresh?next=...` using `REQUEST_PATH_HEADER`.
- `apps/web/src/lib/api/client.ts`
  - Browser API `401 E_UNAUTHENTICATED` currently calls
    `window.location.assign("/login?next=...")`.
- `apps/web/src/app/sign-up/page.tsx`
  - Normalizes inbound `next` and redirects to `/login?mode=create`, currently
    omitting default `/libraries`.
- `apps/web/src/app/extension/connect/start/route.ts`
  - Owns extension auth gating for its public route and uses
    `buildLoginRedirectUrl()` or `/auth/refresh?next=...`.
- E2E helpers
  - `e2e/tests/auth-bootstrap.ts` forces magic-link bootstrap through
    `/login?next=/libraries`.

### Auth return consumers

- `apps/web/src/app/login/page.tsx`
  - Reads and normalizes `next`.
  - Redirects active sessions to it.
  - Passes it to `LoginPageClient`.
- `apps/web/src/app/login/LoginPageClient.tsx`
  - Sends `next` through password form hidden fields.
  - Sends `next` through OAuth provider GET forms.
  - Sends `next` through Android shell deep links.
- `apps/web/src/app/auth/password/route.ts`
  - Normalizes submitted `next`.
  - Redirects sign-in success to it.
  - Sends sign-in/create failures back to `/login`, currently omitting default
    `/libraries`.
  - Ignores `next` on create-account success and sends the user to the default
    authenticated route.
- `apps/web/src/app/auth/oauth/route.ts`
  - Normalizes `next` for sign-in.
  - Ignores requested `next` for identity-link mode, using
    `/settings/identities`.
  - Builds Supabase `redirectTo` callback URLs.
- `apps/web/src/lib/auth/callback.ts`
  - Normalizes callback `next`.
  - Redirects successful browser callback to the target.
  - Redirects handoff success/error through `nexus://auth/handoff`.
- `apps/web/src/app/auth/handoff/route.ts`
  - Normalizes handoff `next`.
  - Redirects successful WebView session setup to the target.
- `apps/web/src/app/auth/refresh/route.ts`
  - Normalizes refresh `next`.
  - Redirects successful refresh to the target.
  - Redirects failed refresh to `/login` with session-ended feedback.

### Related defaults

- `apps/web/src/lib/auth/redirects.ts`
  - `DEFAULT_AUTH_REDIRECT = "/libraries"`.
- `apps/web/src/lib/workspace/workspaceHref.ts`
  - `WORKSPACE_DEFAULT_FALLBACK_HREF = "/libraries"`.
- `apps/web/next.config.ts`
  - Root `/` redirects to `/libraries`.
- `apps/web/src/lib/workspace/*`
  - `/libraries` is a neutral workspace fallback and restore destination.

### Existing duplicate and stale patterns

- `docs/cutovers/codebase-cleanliness-audit.md` already calls out:
  - dead `signInWithPasswordAction` and `signUpWithPasswordAction`,
  - duplicate ad hoc path validation in `signInWithPasswordAction`,
  - `apiFetch()` performing login navigation inside transport parsing,
  - duplicate auth status constants,
  - duplicate `noStore()` helpers,
  - duplicate session-ended feedback-cookie writes.
- `docs/architecture.md` still names `paneRouteRegistry.tsx`, while live code
  now uses `paneRouteModel.ts`, `paneRouteTable.ts`, and
  `paneRenderRegistry.tsx`.

## Scope

In scope:

- Canonical auth return-target parsing and typing.
- Open-redirect hardening for every auth return sink.
- Default `/libraries` query suppression in user-visible auth URLs.
- Central app-home route ownership for auth and workspace defaults.
- Elimination of dead password sign-in/sign-up server actions.
- Removal of login navigation from `apiFetch()`.
- A single client-side unauthenticated API failure owner.
- Consolidation of local `next` URL-setting patterns into auth-owned helpers.
- Focused auth route helper cleanup that directly reduces drift in this
  capability.
- Unit, component, E2E, deployed smoke, and provider-state verification updates.
- Documentation updates where current docs refer to stale route-registry names
  or incomplete auth-return contracts.

Out of scope:

- Changing Supabase as the identity provider.
- Changing the session-cookie wire format.
- Changing FastAPI JWT verification.
- Changing library/workspace product behavior.
- Changing the Android OAuth architecture.
- Building a modal inline reauthentication flow.
- Preserving URL hashes across middleware redirects. URL fragments do not reach
  servers. Hash-preserving auth requires link-generation or client-side capture
  work and is a separate capability.
- Refactoring the whole BFF proxy duplication in `proxy.ts`. This spec touches
  `apiFetch()` ownership, not the full proxy fetch-and-respond duplication.

## Non-goals

- No compatibility shim for old auth helper names.
- No route-local "also check for // here" patches.
- No accepting additional return-target parameter names such as `returnTo`,
  `redirectTo`, or `from`. `next` remains the only public return-target
  parameter.
- No cookie or session storage of return intent for ordinary login. URL return
  intent remains sufficient for this app and keeps OAuth/provider flows explicit.
- No fallback to external origins.
- No wildcard Supabase redirect allowlist.
- No client-held Supabase tokens.
- No direct browser calls to FastAPI product APIs.

## Capability contract

### Name

Capability: auth return target.

Parameter name on public URLs: `next`.

Internal semantic name: `AuthReturnTarget`.

The public query parameter can remain `next` because it is short, conventional,
and already encoded in tests, provider callbacks, and deployed smokes. The
internal code should stop calling the canonical value an "auth redirect" because
that conflates "where the user should return" with "the act of redirecting".

### Data model

`AuthReturnTarget` is a canonical in-app href:

- Starts with exactly one `/`.
- Never starts with `//`.
- Is not an absolute URL.
- Is not protocol-relative.
- Is not `/login`.
- Is not `/auth`.
- Does not start with `/auth/`.
- Is parseable against a fixed same-origin base.
- Preserves `pathname + search + hash` after parsing.
- Uses the app default authenticated href when raw input is absent or invalid.

Implementation should make the trusted state visible to TypeScript. Preferred:

```ts
export type AuthReturnTarget = string & { readonly __authReturnTarget: unique symbol };
```

Only the auth-return-target parser should construct this branded value. Redirect
builders and sinks should accept `AuthReturnTarget`, not arbitrary `string`, when
they are consuming an already-normalized target.

### Default target

The default authenticated app href is owned once.

Create a neutral route-default module, for example:

```ts
// apps/web/src/lib/routes/defaults.ts
export const APP_AUTHENTICATED_HOME_HREF = "/libraries";
```

Then:

- `WORKSPACE_DEFAULT_FALLBACK_HREF` derives from that constant.
- Auth return-target default derives from that constant.
- Root redirect in `next.config.ts` either imports the same value if build-safe,
  or uses a tested config helper that is checked against it.
- E2E helpers avoid declaring their own unrelated fallback constant where
  practical.

Auth must not import workspace internals to find its default. Workspace and auth
both depend on the neutral route-default module.

### Parser API

Replace `normalizeAuthRedirect()` with a return-target API.

Preferred final shape:

```ts
export const DEFAULT_AUTH_RETURN_TARGET: AuthReturnTarget;

export function parseAuthReturnTarget(
  rawValue: string | null | undefined,
): AuthReturnTarget;

export function parseAuthReturnTargetWithFallback(
  rawValue: string | null | undefined,
  fallback: AuthReturnTarget,
): AuthReturnTarget;

export function authReturnTargetToHref(target: AuthReturnTarget): string;
```

Hard cutover means all old names are deleted:

- delete `DEFAULT_AUTH_REDIRECT`,
- delete `normalizeAuthRedirect`,
- update every import,
- update every test assertion.

If the implementation keeps a single parser function, it must not accept an
arbitrary fallback string. A fallback must already be an `AuthReturnTarget`.

### Parser algorithm

For raw untrusted input:

1. If absent, return the default.
2. Trim surrounding whitespace.
3. Reject if it does not start with `/`.
4. Reject if it starts with `//`.
5. Parse with `new URL(trimmed, AUTH_RETURN_TARGET_BASE)`.
6. Build `normalized = pathname + search + hash`.
7. Re-run the invariant against `normalized`.
8. Reject if `normalized` is `/login`, `/auth`, or starts with `/auth/`.
9. Return `normalized` as `AuthReturnTarget`.

The post-parse invariant check is mandatory. It is the security fix.

Test cases must include at least:

- `undefined`, `null`, empty, whitespace.
- `/search?q=oauth#top`.
- `https://evil.example/x`.
- `//evil.example/x`.
- `/..//evil.example`.
- `/%2e%2e//evil.example` if the URL parser produces a dangerous normalized
  result.
- `/login`, `/login?next=/x`.
- `/auth`, `/auth/refresh?next=/libraries`.
- `/libraries`.

### URL builder API

All auth URLs that carry return intent are built by auth-owned helpers.

Preferred helpers:

```ts
export function buildLoginUrl(origin: string, target: AuthReturnTarget): URL;
export function buildLoginUrlWithFeedback(
  origin: string,
  target: AuthReturnTarget,
  feedback: AuthFeedback,
): URL;
export function buildAuthRefreshUrl(origin: string, target: AuthReturnTarget): URL;
export function buildAuthCallbackUrl(
  redirectOrigin: string,
  target: AuthReturnTarget,
  options?: AuthCallbackOptions,
): string;
export function buildAuthHandoffSuccessDeepLink(
  code: string,
  target: AuthReturnTarget,
): string;
export function buildAuthHandoffErrorDeepLink(
  errorCode: string,
  target: AuthReturnTarget,
): string;
export function buildAuthStartDeepLink(
  provider: OAuthProvider,
  mode: "signin" | "link",
  target: AuthReturnTarget,
): string;
export function buildAuthNativeGoogleDeepLink(target: AuthReturnTarget): string;
export function buildAuthReturnTargetUrl(
  origin: string,
  target: AuthReturnTarget,
): URL;
```

Rules:

- User-visible `/login` URLs omit `next` when target is default.
- `/auth/refresh` URLs omit `next` when target is default.
- Provider callback URLs omit `next` when target is default.
- Native deep links omit `next` when target is default.
- Non-default return targets always include `next`.
- Error/feedback parameters are separate from return target parameters.
- Raw `URLSearchParams.set("next", ...)` is not allowed outside this module,
  except tests that inspect constructed URLs.

This means:

- `/libraries` anonymous navigation redirects to `/login`.
- `/browse` anonymous navigation redirects to `/login?next=%2Fbrowse`.
- `/conversations?view=compact` redirects to
  `/login?next=%2Fconversations%3Fview%3Dcompact`.
- `GET /auth/refresh` with no `next` defaults to `/libraries`.
- `/auth/callback` with no `next` defaults to `/libraries`.

### Redirect sink API

No route handler constructs `new URL(nextPath, origin)` from an arbitrary string.

Redirect sinks should consume only `AuthReturnTarget` and call an auth-owned URL
builder:

```ts
return NextResponse.redirect(buildAuthReturnTargetUrl(origin, target), {
  status: TEMPORARY_REDIRECT,
});
```

This applies to:

- `/auth/callback` browser success,
- `/auth/handoff` success,
- `/auth/password` sign-in success,
- `/auth/refresh` success,
- authenticated `/login` middleware redirects.

## Final behavior

### Protected page navigation

Anonymous or ended request to `/libraries`:

- Redirects to `/login`.
- Clears invalid auth cookies when applicable.
- If the session ended, includes session-ended feedback:
  `/login?error_description=...`, not `/login?next=%2Flibraries&...`.

Anonymous or ended request to `/browse`:

- Redirects to `/login?next=%2Fbrowse`.

Anonymous or ended request to `/conversations?view=compact`:

- Redirects to `/login?next=%2Fconversations%3Fview%3Dcompact`.

Refreshable request to `/libraries`:

- Redirects to `/auth/refresh`.

Refreshable request to `/browse`:

- Redirects to `/auth/refresh?next=%2Fbrowse`.

### Login page

`/login`:

- Renders sign-in/create UI for anonymous users.
- Redirects active sessions to `/libraries`.
- Password and provider forms submit no default `next` value.

`/login?next=%2Fsearch%3Fq%3Doauth`:

- Renders sign-in/create UI for anonymous users.
- Redirects active sessions to `/search?q=oauth`.
- Password and provider forms carry `next=/search?q=oauth`.

`/login?next=%2F..%2F%2Fevil.example` or equivalent:

- Treats `next` as invalid.
- Uses `/libraries`.
- Does not emit a protocol-relative redirect.

### Password auth

`POST /auth/password` remains the only password sign-in/create account endpoint.

Sign-in:

- Validates same-origin form post.
- Parses submitted `next` through the canonical return-target parser.
- On success redirects to the parsed target.
- On failure redirects to `/login` or `/login?next=<non-default>&...`.

Create account:

- Validates same-origin form post.
- On success redirects to default authenticated home.
- On failure redirects to `/login?mode=create` or
  `/login?mode=create&next=<non-default>&...`.

`signInWithPasswordAction` and `signUpWithPasswordAction` are deleted.

`setPasswordAction`, `changePasswordAction`, and `removePasswordAction` remain.
They are account-management actions, not login APIs.

### OAuth and callback

`/auth/oauth`:

- Parses sign-in return target once.
- Ignores requested return target for identity-link mode.
- Resolves callback origin through `callback-origin.ts`.
- Builds callback URLs through auth return-target helpers.
- Does not include `next` for default target.

`/auth/callback`:

- Parses callback return target once.
- Resolves callback origin through `callback-origin.ts`.
- Redirects browser success through `buildAuthReturnTargetUrl()`.
- Redirects failures through login URL builders.
- Redirects handoff outcomes through deep-link builders.
- Cannot redirect to an external origin through `next`.

### Native handoff

`nexus://auth/start`, `nexus://auth/native`, and `nexus://auth/handoff` deep
links:

- Use `next` only for non-default return targets.
- Treat missing `next` as default authenticated home.
- Treat invalid `next` as default authenticated home.

Android remains a shell. It does not parse product return targets beyond
passing web-owned auth deep links through the existing shell flow.

### Refresh

`GET /auth/refresh`:

- Parses `next` through the canonical return-target parser.
- Uses default when missing.
- On success redirects to the target with rotated cookies.
- On failure redirects to login with session-ended feedback and default-query
  suppression.

`POST /auth/refresh`:

- Remains proactive only.
- Does not accept or emit `next`.

### API 401 in authenticated client

The HTTP transport module becomes pure:

- `parseApiResponse()` parses responses.
- `apiFetch()`, `apiPostFormData()`, and `apiKeepaliveJson()` throw `ApiError`.
- `apps/web/src/lib/api/client.ts` does not import auth navigation and does not
  call `window.location.assign()`.

Authenticated app navigation owns unauthenticated API failure behavior.

Preferred final structure:

- `apps/web/src/lib/auth/client-return-target.ts`
  - Reads current `window.location.pathname + window.location.search`.
  - Builds the login URL through auth URL builders.
  - Omits `next` for default target.
- `apps/web/src/lib/auth/UnauthenticatedApiBoundary.tsx` or equivalent
  authenticated-shell provider.
  - Exposes `handleApiError(error: unknown): boolean`.
  - Redirects once per session-ended event.
  - Does not redirect while already on `/login`.
- `apps/web/src/lib/api/useResource.ts`
  - Calls the boundary handler before storing an `E_UNAUTHENTICATED` error.
- Client mutation call sites under `(authenticated)` use one shared hook,
  for example `useAuthenticatedApi()`, instead of importing raw `apiFetch`.

Hard cutover rule: raw `apiFetch` remains available only to low-level
infrastructure and tests. Product components use the authenticated API hook or a
domain client that is itself wired to the boundary.

### Workspace composition

`/libraries` remains the default authenticated workspace route.

The auth system does not own workspace semantics. It only owns the default
return target. Workspace owns:

- pane fallback,
- neutral `/libraries` restore semantics,
- route normalization,
- pane rendering and preload.

Auth and workspace share only the neutral default app-home route constant.

Update stale docs:

- `docs/architecture.md` should describe live route modules:
  `paneRouteModel.ts`, `paneRouteTable.ts`, and `paneRenderRegistry.tsx`, not a
  non-existent `paneRouteRegistry.tsx`.

### Extension auth

`/extension/connect/start` stays public and keeps its own extension redirect URI
allowlist.

Rules:

- Extension callback origin parsing remains separate from auth callback origin
  parsing.
- Do not couple `NEXUS_EXTENSION_REDIRECT_ORIGINS` to
  `AUTH_ALLOWED_REDIRECT_ORIGINS`.
- Extension connect may call auth return-target builders for returning to its
  own route when the user needs login or refresh.

### Deploy and provider state

Hosted Supabase Auth redirect configuration remains provider state.

Final release proof for auth return-target changes must include:

- local unit/component route tests,
- real-stack Playwright auth behavior,
- `deploy/supabase/verify-auth-redirects.sh`,
- `deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly` for
  production read-only validation,
- staging deployed Playwright route if a mutating provider round trip is needed.

`make smoke` should either:

- run the redirect-construction smoke when the required env is present, or
- be documented as insufficient for auth redirect/provider changes and a new
  Make target should own the full auth smoke.

Preferred new Make target:

```make
smoke-auth-redirects:
        ./deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly ...
```

Do not hide provider-state verification behind a dashboard checklist.

## File plan

### Auth return target

- `apps/web/src/lib/auth/redirects.ts`
  - Replace redirect-named parser with return-target parser.
  - Revalidate post-parse normalized value.
  - Add branded `AuthReturnTarget`.
  - Add default-query-suppressing URL builders.
  - Delete old exports.
- `apps/web/src/lib/auth/redirects.test.ts`
  - Add malformed post-parse protocol-relative cases.
  - Update default-query suppression expectations.
  - Assert every builder omits default and carries non-default.

### Default route ownership

- `apps/web/src/lib/routes/defaults.ts` or equivalent
  - Add `APP_AUTHENTICATED_HOME_HREF`.
- `apps/web/src/lib/workspace/workspaceHref.ts`
  - Derive `WORKSPACE_DEFAULT_FALLBACK_HREF`.
- `apps/web/src/lib/auth/redirects.ts`
  - Derive default auth return target.
- `apps/web/next.config.ts`
  - Keep root redirect aligned with `APP_AUTHENTICATED_HOME_HREF`.
- Tests under `apps/web/src/lib/workspace/*`
  - Update imports/expectations as needed.

### Auth routes and middleware

- `apps/web/src/lib/supabase/middleware.ts`
  - Use return-target parser/builders.
  - Use default-query suppression for `/login` and `/auth/refresh`.
  - Consume shared status and feedback-cookie helpers.
- `apps/web/src/lib/auth/dal.ts`
  - Use return-target parser/builders.
  - Do not manually interpolate `?next=`.
- `apps/web/src/app/login/page.tsx`
  - Parse return target.
  - Redirect active sessions through the return-target sink helper.
- `apps/web/src/app/login/LoginPageClient.tsx`
  - Accept `AuthReturnTarget` or a safe href derived from it.
  - Avoid hidden default `next` inputs.
- `apps/web/src/app/sign-up/page.tsx`
  - Use new parser/builders.
- `apps/web/src/app/auth/password/route.ts`
  - Use return-target parser/builders.
  - Add direct malicious `next` tests.
- `apps/web/src/app/auth/oauth/route.ts`
  - Use return-target parser/builders.
  - Omit default `next` from callback URLs.
- `apps/web/src/lib/auth/callback.ts`
  - Use return-target parser and sink helper.
- `apps/web/src/app/auth/handoff/route.ts`
  - Use return-target parser and sink helper.
- `apps/web/src/app/auth/refresh/route.ts`
  - Use return-target parser/builders.

### Dead password APIs

- `apps/web/src/lib/auth/password-actions.ts`
  - Delete `signInWithPasswordAction`.
  - Delete `signUpWithPasswordAction`.
  - Keep account password management actions.
- `apps/web/src/lib/auth/password-actions.test.ts`
  - Remove sign-in/sign-up server-action tests.
  - Keep account password tests.
- UI tests that mock these dead actions
  - Remove dead mock keys.

### Client API auth boundary

- `apps/web/src/lib/api/client.ts`
  - Delete `window.location.assign()` block.
  - Preserve pure `ApiError` behavior.
- `apps/web/src/lib/api/client.test.ts`
  - Replace "redirects browser callers" test with "throws structured
    unauthenticated API error without navigation".
- `apps/web/src/lib/api/useResource.ts`
  - Route `E_UNAUTHENTICATED` through authenticated API boundary before storing a
    retryable resource error.
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`
  - Mount the boundary/provider.
- Product call sites under `(authenticated)` and shared authenticated components
  - Replace direct `apiFetch` imports with the auth-aware hook or domain clients.

### Auth helper consolidation

Focused cleanup allowed in this cutover:

- Shared auth HTTP status constants:
  - `TEMPORARY_REDIRECT = 307`.
  - `SEE_OTHER = 303`.
- Shared `noStore()` helper.
- Shared session-ended feedback-cookie setter.

Do not expand this cutover into unrelated proxy fetch duplication.

### Deploy and docs

- `deploy/smoke/auth-smoke.sh`
  - Update login redirect assertions for default-query suppression.
  - Keep a non-default protected path assertion that proves `next` preservation.
- `deploy/smoke/auth-redirect-construction-smoke.sh`
  - Continue running Supabase provider verifier.
  - Add or retain coverage for callback URL construction without default `next`.
- `deploy/supabase/verify-auth-redirects.sh`
  - No provider allowlist relaxation.
- `Makefile`
  - Add a specific auth redirect smoke target or clearly wire it into the right
    release command.
- `docs/architecture.md`
  - Update pane route module names.
  - Add the auth return-target contract near the auth redirect-origin section.
- `deploy/env/README.md`
  - Keep redirect-origin/provider verification language current.

## API design details

### Branded target versus string

The return-target parser should return a branded value because route handlers
otherwise cannot distinguish:

- untrusted query-string text,
- already parsed return target,
- arbitrary in-app href,
- full external URL.

The brand is not a security boundary by itself, but it forces redirect sinks to
get values from the parser at compile time.

### Missing target means default

Missing `next` is not an error. It means default authenticated app home.

That is why default-query suppression is safe:

- `/login` and `/login?next=%2Flibraries` become equivalent.
- `/auth/callback` and `/auth/callback?next=%2Flibraries` become equivalent.
- `/auth/refresh` and `/auth/refresh?next=%2Flibraries` become equivalent.

Invalid `next` also resolves to default. The app does not need to show an error
for a malformed return target. The redirect target is a navigation hint, not a
user-authored resource.

### Why not store return intent in a cookie

A return-intent cookie would hide query params, but it adds state and edge
cases:

- multiple tabs compete for one cookie,
- OAuth callbacks need to correlate state,
- provider round trips become less transparent,
- Android and extension flows still need explicit carrier state,
- clearing auth cookies must avoid clearing unrelated return cookies.

For a one-user prototype, URL state is simpler, auditable, and sufficient.
The professional move is to validate and centralize it, not replace it with a
stateful mechanism.

### Why not keep `next` for default

Default `next` is redundant. It makes the most common unauthenticated path look
busier than it is and makes tests overfit a parameter that carries no extra
state.

Non-default targets still need `next`. The hard cutover is not "delete next".
It is "only emit next when it carries information".

## Acceptance criteria

### Security

- `normalize` or `parseAuthReturnTarget("/..//evil.example")` returns default.
- No auth redirect sink can consume a raw query-param string.
- No auth redirect sink can redirect to an external origin through `next`.
- `/auth/*`, `/auth`, and `/login` return targets resolve to default.
- Raw and post-parse protocol-relative targets resolve to default.
- Unit tests cover parser-normalized protocol-relative paths.
- OWASP-style open-redirect tests exist at the auth-return-target owner and at
  one route-level sink.

### URL cleanliness

- Anonymous `/libraries` navigation redirects to `/login`.
- Anonymous `/browse` navigation redirects to `/login?next=%2Fbrowse`.
- Refreshable `/libraries` navigation redirects to `/auth/refresh`.
- Refreshable `/browse` navigation redirects to `/auth/refresh?next=%2Fbrowse`.
- OAuth callback URLs omit `next` for default target.
- Native auth deep links omit `next` for default target.
- Login forms do not submit hidden `next=/libraries`.
- Login forms do submit hidden `next` for non-default targets.

### Ownership

- `rg 'normalizeAuthRedirect|DEFAULT_AUTH_REDIRECT' apps/web/src` returns no
  production hits.
- `rg 'searchParams\\.set\\(\"next\"' apps/web/src` returns only auth-owned URL
  builder code and tests.
- `rg 'window\\.location\\.assign' apps/web/src/lib/api/client.ts` returns no
  hits.
- `signInWithPasswordAction` and `signUpWithPasswordAction` are deleted.
- Auth and workspace do not each declare independent `/libraries` default
  constants.
- `apiFetch()` is pure transport parsing.

### Behavior

- Password sign-in success returns to a non-default target.
- Password sign-in failure preserves a non-default target.
- Password create-account success goes to default authenticated home.
- OAuth sign-in success returns to a non-default target.
- OAuth errors preserve a non-default target back to login.
- Handoff success returns to a non-default target.
- Refresh success returns to a non-default target.
- Session-ended feedback appears on login after failed refresh or ended cookie.
- Extension connect still validates extension redirect origins separately.

### Tests

Required targeted tests:

- `apps/web/src/lib/auth/redirects.test.ts`
- `apps/web/src/lib/supabase/middleware.test.ts`
- `apps/web/src/lib/auth/dal.test.ts`
- `apps/web/src/app/login/LoginPageClient.test.tsx`
- `apps/web/src/app/auth/password/route.test.ts`
- `apps/web/src/app/auth/oauth/route.test.ts`
- `apps/web/src/lib/auth/callback.test.ts`
- `apps/web/src/app/auth/handoff/route.test.ts`
- `apps/web/src/app/auth/refresh/route.test.ts`
- `apps/web/src/lib/api/client.test.ts`
- `apps/web/src/lib/api/useResource.test.tsx`
- focused E2E for unauthenticated default and non-default login redirects.

Required deployed checks for release:

- `deploy/supabase/verify-auth-redirects.sh`.
- `deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly`.
- Staging deployed Playwright auth redirect construction when provider round trip
  mutations are part of the release.

## Implementation sequence

1. Add neutral app route-default owner.
2. Replace auth parser with branded auth return-target parser.
3. Add tests proving post-parse protocol-relative rejection.
4. Replace auth URL builders and redirect sinks.
5. Suppress default `next` in login, refresh, callback, and deep-link builders.
6. Update middleware, DAL, login, sign-up, password, OAuth, callback, handoff,
   refresh, and extension connect call sites.
7. Delete dead password sign-in/sign-up server actions and tests.
8. Remove `apiFetch()` login navigation and add the authenticated client API
   boundary.
9. Migrate authenticated product call sites to the boundary or auth-aware API
   hook.
10. Consolidate focused auth helper duplication: statuses, `noStore()`,
    session-ended feedback cookie setter.
11. Update E2E helpers and deployed smoke expectations.
12. Update docs.
13. Run targeted tests.
14. Run deployed/provider verification when publishing.

## Verification commands

Local targeted checks:

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run test:unit -- \
  src/lib/api/effect-discipline.test.ts \
  src/lib/auth/redirects.test.ts \
  src/lib/auth/client-return-target.test.ts \
  src/lib/api/client.test.ts \
  src/lib/auth/password-actions.test.ts \
  src/lib/supabase/middleware.test.ts \
  src/lib/auth/dal.test.ts \
  src/app/auth/password/route.test.ts \
  src/app/auth/oauth/route.test.ts \
  src/lib/auth/callback.test.ts \
  src/app/auth/callback/route.test.ts \
  src/app/auth/handoff/route.test.ts \
  src/app/auth/refresh/route.test.ts \
  src/app/extension/connect/start/route.test.ts \
  src/app/sign-up/page.test.ts
cd apps/web && bun run test:browser -- \
  src/lib/auth/UnauthenticatedApiBoundary.test.tsx \
  src/lib/api/useResource.test.tsx \
  src/app/login/LoginPageClient.test.tsx \
  "src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.test.tsx"
```

Focused E2E:

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/auth.spec.ts --project=chromium"
make test-e2e PLAYWRIGHT_ARGS="tests/auth-refresh.spec.ts --project=chromium"
```

Deployment/provider verification:

```bash
deploy/supabase/verify-auth-redirects.sh
deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly
```

Use repo Make wrappers for Playwright where they own Supabase startup and auth
bootstrap.

## Key decisions

- Keep `next` as the public parameter name.
- Rename the internal concept to auth return target.
- Use a branded return-target type.
- Revalidate after URL parsing.
- Omit default `next` everywhere it is redundant.
- Keep URL state instead of adding return-intent cookies.
- Delete dead password login actions instead of adapting them.
- Move API 401 navigation out of transport parsing.
- Keep extension redirect origin policy separate from auth callback origins.
- Treat hosted Supabase redirect state as part of release verification.

## Resolved implementation decisions

- `next.config.ts` imports `APP_AUTHENTICATED_HOME_HREF`; the route default is a
  plain string module with no workspace/runtime dependency.
- The authenticated API boundary is a mounted unhandled-rejection listener plus
  one explicit `handleUnauthenticatedApiError()` function for caught product
  mutations. This avoids a second fetch API while keeping `apiFetch()` pure.
- `apiKeepaliveJson()` stays transport-only. Non-unload persistence catches call
  the auth handler; unload keepalive writes remain best-effort because redirect
  during unload has no useful lifecycle.
- Default `next` is omitted from web login/refresh/callback/native links and
  from E2E magic-link bootstrap.

## Done means

The final codebase has one return-target parser, one app-home default, no active
open-redirect path through `next`, no dead password login server actions, no
transport-layer auth navigation, no default `?next=%2Flibraries` noise, and a
release lane that proves both application redirect construction and hosted
Supabase provider redirect state.
