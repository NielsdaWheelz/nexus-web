# Auth Origin And Redirect Hardening Cutover

## Status

Target-state implementation spec. This document owns the production-ready plan
for three related auth-origin controls:

- Next.js Server Action origin admission.
- App-side auth redirect-origin construction.
- Supabase hosted Auth redirect URL configuration verification.

The implementation is a hard cutover. There is no legacy mode, compatibility
alias, dashboard-only checklist, debug endpoint, or production fallback path.

## External References

- Next.js `serverActions.allowedOrigins`:
  https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions
- Supabase Auth redirect URLs:
  https://supabase.com/docs/guides/auth/redirect-urls
- Supabase Management API:
  https://supabase.com/docs/reference/api/getting-started

Key facts these references establish:

- Next.js allows Server Actions from the same origin by default. Extra origins
  belong in `experimental.serverActions.allowedOrigins`, as domain patterns,
  when a proxy or deployment topology makes the browser `Origin` differ from the
  host Next.js observes.
- Supabase `redirectTo` / `emailRedirectTo` URLs must be present in the
  project's Auth redirect URL allowlist. Production should use exact callback
  URLs, not broad wildcards.
- Supabase project Auth config can be read through the Management API with an
  authenticated request. The deploy verifier must use read-only access.

## Scope

In scope:

- Frontend Next.js App Router auth routes and Server Actions in `apps/web`.
- App-side construction of URLs passed to Supabase Auth as `redirectTo` or
  `emailRedirectTo`.
- Production/staging env validation for Vercel and deployment scripts.
- Supabase hosted Auth URL Configuration verification.
- Local and CI tests that prove redirect construction and fail-closed behavior.
- Deployment smoke checks that catch origin-policy and provider-config drift.
- Consolidation of duplicate origin parsing where the semantics are genuinely
  shared.

Out of scope:

- Replacing Supabase Auth.
- Moving the frontend off Vercel.
- Adding a browser Supabase client. OAuth and Auth operations remain server-side.
- Changing backend JWT verification, BFF bearer forwarding, or stream-token
  auth.
- Adding test-only routes or "dry-run" production endpoints.
- Automatically mutating Supabase Auth config during deploy. The first
  production-ready gate is read-only verification; config changes remain an
  explicit operator action unless a separate change designs an audited apply
  path.

## Goals

- Make origin policy explicit at every layer that can reject or redirect an auth
  flow.
- Fail before deploy when env or provider config is wrong.
- Fail closed before calling Supabase when an inbound request cannot prove a safe
  redirect origin.
- Catch provider/dashboard drift with a machine-readable Supabase verifier.
- Add a smoke path that proves redirect construction, not only auth health.
- Reuse one neutral origin parser where repeated syntax parsing exists, while
  keeping policy ownership separate.
- Keep the public API surface small: one parser module, one auth-origin owner,
  one redirect-builder owner, one deployment verifier.

## Non-Goals

- Do not use `serverActions.allowedOrigins` as a broad compatibility list.
  Adding entries broadens a CSRF admission gate and must be justified by the
  deployment topology.
- Do not derive Next.js Server Action allowed origins from
  `AUTH_ALLOWED_REDIRECT_ORIGINS` without converting and validating the semantics.
  Next expects domains/patterns; auth redirects use full URL origins.
- Do not use Supabase's redirect allowlist as the only protection against
  Host-header poisoning. App-side construction must be safe before the Supabase
  SDK is called.
- Do not add wildcard production Supabase redirect URLs. Preview and local
  wildcard policy, if ever needed, must be environment-specific.
- Do not export auth-private helpers only so another route can share them.
  Shared syntax parsing belongs in a policy-neutral security module.
- Do not preserve old env names, old defaults, or fallback branches for
  deployment misconfiguration.

## Current Owners To Reuse

- `apps/web/src/lib/auth/callback-origin.ts` owns auth redirect-origin
  resolution from inbound transport metadata. It already has separate route and
  Server Action entry points:
  `resolveCallbackRedirectOrigin(request, requestUrl)` and
  `resolveServerActionRedirectOrigin(headers)`.
- `apps/web/src/lib/auth/redirects.ts` owns safe `next` normalization and
  builders such as `buildAuthCallbackUrl`.
- `apps/web/src/lib/env.ts` owns deployment-env validation for frontend build
  and runtime config, and is already imported by `next.config.ts` to fail bad
  deployed builds before promotion.
- `deploy/vercel/sync-env.sh` owns Vercel production env synchronization and
  readback verification.
- `deploy/smoke/auth-smoke.sh` owns safe production auth HTTP smoke checks.
- `supabase/config.toml` owns local Supabase Auth redirect URLs.
- `deploy/env/*.example`, `.env.example`, `deployment.md`, and
  `docs/architecture.md` own the operator-facing contract.

## Duplicate Patterns To Consolidate

Consolidate syntax parsing, not security policy.

Create a neutral parser module:

`apps/web/src/lib/security/origin.ts`

Public contract:

```ts
export interface WebOrigin {
  readonly origin: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly host: string;
  readonly isLocalhost: boolean;
}

export interface OriginListParseResult {
  readonly origins: readonly WebOrigin[];
  readonly invalidValues: readonly string[];
}

export function parseWebOrigin(value: string): WebOrigin | null;
export function parseWebOriginList(rawValue: string | undefined): OriginListParseResult;
```

Parser rules:

- Accept only `http:` and `https:`.
- Reject username/password, path other than `/`, query, and hash.
- Normalize through `URL.origin`.
- Deduplicate by normalized origin.
- Report invalid entries instead of silently losing them.
- Do not decide whether `http` is acceptable in production.
- Do not decide whether an origin is trusted.
- Do not read env.

Callers keep policy:

- `callback-origin.ts` decides auth redirect allowlist and trusted-proxy
  behavior.
- `env.ts` decides CSP connect-origin deployment requirements.
- `app/extension/connect/start/route.ts` decides extension redirect policy for
  `NEXUS_EXTENSION_REDIRECT_ORIGINS`.
- Deploy shell scripts either call a small Node/TS validator that uses the same
  parser contract or keep equivalent explicit checks. If shell checks stay, the
  tests must cover parity.

This removes repeated split/trim/URL-normalization logic without creating an
options-heavy generic policy helper.

## Target Behavior

### Server Action Origin Admission

Final state:

- Direct Vercel custom-domain deployments with matching browser origin and
  observed host do not add extra `serverActions.allowedOrigins`.
- Any deployment that places a host-rewriting proxy/CDN in front of the Next.js
  app sets a minimal Server Action allowed-origin domain list.
- The allowed-origin list is build-time config and is validated before Vercel
  sync and at `next build`.
- Values are domain patterns accepted by Next.js, not URL origins:
  `app.example.com`, `*.app.example.com`.
- Values must not include scheme, path, query, fragment, credentials, or blank
  entries.
- Production values must not include `*`, broad public suffixes, localhost, or
  preview wildcards.

Recommended env contract:

```text
SERVER_ACTION_ALLOWED_ORIGINS=
```

Rules:

- Empty means no extra Server Action origins; same-origin only.
- Non-empty means the current topology requires extra admission and every value
  is explicitly intended.
- `AUTH_TRUSTED_PROXY_ORIGINS` does not automatically populate this value.
- `AUTH_ALLOWED_REDIRECT_ORIGINS` does not automatically populate this value.
- If a documented proxied frontend topology is enabled and
  `SERVER_ACTION_ALLOWED_ORIGINS` is empty, deploy validation fails.

Implementation owner:

- `apps/web/next.config.ts` sets
  `experimental.serverActions.allowedOrigins` only when the validated list is
  non-empty.
- `apps/web/src/lib/env.ts` or a sibling server-only env module validates this
  build-time value. It must be safe to import from `next.config.ts`.

### App Redirect-Origin Construction

Final state:

- All URLs passed to Supabase Auth as `redirectTo` or `emailRedirectTo` use:
  `resolveCallbackRedirectOrigin` or `resolveServerActionRedirectOrigin` first,
  then `buildAuthCallbackUrl`.
- `AUTH_ALLOWED_REDIRECT_ORIGINS` is an origin-only list. In staging/prod it is
  required, strict, and HTTPS-only.
- `AUTH_TRUSTED_PROXY_ORIGINS` is optional and origin-only. It allows forwarded
  host use only when the direct origin is itself a trusted proxy origin.
- Invalid configured origins fail deployed builds. They are not silently dropped
  in staging/prod.
- Local development may use localhost HTTP origins only under `NEXUS_ENV=local`
  or `NEXUS_ENV=test`.
- A spoofed `host` or `x-forwarded-host` causes a public auth failure before
  Supabase is called.

Required app behavior:

- OAuth start route builds `redirectTo` as:
  allowlisted origin plus `/auth/callback?next=...`.
- Auth callback route re-resolves the callback origin before exchanging the
  Supabase code and before final app redirect.
- Email-change Server Action builds `emailRedirectTo` as:
  allowlisted origin plus `/auth/callback?next=%2Fsettings%2Faccount`.
- Server Actions catch resolver errors at the action boundary, log a server-side
  `auth_*_origin_rejected` event, return the existing public failure message,
  and perform no Supabase side effect.

### Supabase Redirect Allowlist Verification

Final state:

- A deploy verifier reads the hosted Supabase project Auth config and compares
  it to the repo env contract.
- It verifies `site_url` equals the canonical production app origin
  (`APP_PUBLIC_URL` normalized to origin).
- It verifies every `AUTH_ALLOWED_REDIRECT_ORIGINS` entry has an exact
  `${origin}/auth/callback` entry in Supabase's redirect URL allowlist.
- In production, it rejects wildcard redirect URL patterns for app callbacks.
- It prints only pass/fail facts and redacted host/path values. It never prints
  access tokens, anon keys, service-role keys, auth codes, cookies, or email
  confirmation tokens.

Recommended script:

`deploy/supabase/verify-auth-redirects.sh`

Inputs:

```text
--env-file deploy/env/env-prod
--frontend-env-file deploy/env/env-prod-frontend
--project-ref <supabase-project-ref>
SUPABASE_MANAGEMENT_ACCESS_TOKEN=<read-only token>
```

Project ref may be explicit or derived from `NEXT_PUBLIC_SUPABASE_URL` after
strict validation. The Management API token is operator/CI-only and must not be
synced to Vercel or the VPS.

Verifier comparison:

- Normalize `APP_PUBLIC_URL` to an origin and require HTTPS in prod.
- Parse `AUTH_ALLOWED_REDIRECT_ORIGINS` with the same neutral parser used by app
  code.
- Fetch `GET https://api.supabase.com/v1/projects/{ref}/config/auth`.
- Read `site_url` and `uri_allow_list` from the response.
- Split `uri_allow_list` according to Supabase's comma-separated Auth config
  representation.
- Compare exact normalized strings:
  `${origin}/auth/callback`.
- Fail on missing entries, extra production wildcard callback entries, invalid
  app origins, invalid Supabase URLs, HTTP production app origins, or an
  unreadable Management API response.

### Redirect-Construction Smoke

Final state:

- Existing `deploy/smoke/auth-smoke.sh` continues to test safe GET auth health.
- A new redirect-construction smoke covers the redirect URL that the app asks
  Supabase to send.
- No smoke endpoint is added to production.
- No smoke bypasses Next's Server Action origin gate.
- No smoke depends on local-only Supabase config for production confidence.

Two gates are required:

1. CI/unit constructor smoke:
   - Runs in `apps/web` unit tests.
   - Mocks the Supabase SDK boundary only.
   - Calls the real Server Action or route owner.
   - Asserts the SDK receives the exact `redirectTo` or `emailRedirectTo`.
   - Asserts spoofed hosts return public failure and do not call Supabase.

2. Deployed smoke:
   - For staging, performs a full email-change or OAuth canary flow with a
     dedicated smoke account and controlled mailbox, then asserts the received
     confirmation/provider callback URL has the expected origin and
     `/auth/callback` path.
   - For production, either runs the same canary flow against isolated canary
     accounts and a reversible email rotation, or remains read-only and combines
     the Supabase verifier with safe HTTP smoke. The production mode must be
     explicit; it must not silently skip.

Recommended scripts:

- `deploy/smoke/auth-redirect-construction-smoke.sh`
- `e2e/tests/auth-redirect-construction.spec.ts`

Required production decision:

- If production canary credentials and mailbox access are not provisioned, the
  production smoke is read-only and must say so. Staging remains the mutating
  proof of the live redirect-construction path.
- If production canary credentials are provisioned, the smoke must restore the
  canary account to its starting state or rotate between two dedicated canary
  accounts. It must be rate-limit-aware.

## Architecture

```text
Inbound auth request or Server Action
        |
        v
Next.js framework Server Action origin gate
        |
        v
apps/web/src/lib/auth/callback-origin.ts
        |
        v
apps/web/src/lib/auth/redirects.ts
        |
        v
Supabase SDK redirectTo/emailRedirectTo
        |
        v
Supabase hosted Auth URL Configuration
        |
        v
/auth/callback route
        |
        v
Supabase code exchange, session cookies, final app redirect
```

Layer responsibilities:

- Next.js admits or rejects Server Action POST requests before app code runs.
- `callback-origin.ts` converts trusted inbound transport metadata into one safe
  app origin or throws.
- `redirects.ts` builds callback URLs and normalizes app-local `next` paths.
- Supabase hosted Auth accepts only configured redirect URLs.
- `/auth/callback` re-validates the request origin before exchanging codes or
  redirecting the user.
- Deploy scripts verify env and external provider config before promotion.

## Capability Contracts

### `lib/security/origin.ts`

Capability: parse origin syntax.

- No env reads.
- No policy decisions.
- No framework imports.
- Returns structured values and parse errors.
- Covered by pure unit tests.

### `lib/auth/callback-origin.ts`

Capability: resolve a safe auth redirect origin from inbound request metadata.

Public API:

```ts
export function resolveCallbackRedirectOrigin(
  request: Request,
  requestUrl: URL
): string;

export function resolveServerActionRedirectOrigin(
  requestHeaders: Headers
): string;
```

Rules:

- These are the only public auth-origin resolvers.
- Parser helpers remain private or move to `lib/security/origin.ts`.
- Direct origin is built from `requestUrl.origin` for routes and from `host`
  alone for Server Actions.
- `x-forwarded-*` can select a forwarded origin only when the direct origin is
  trusted.
- The function returns a normalized origin string or throws.

### `lib/auth/redirects.ts`

Capability: build app-auth redirect URLs from a safe origin and safe local
destination.

Rules:

- `next` values stay path-only and never point at `/login` or `/auth/*`.
- Callback URL path is `/auth/callback`.
- Handoff deep links remain `nexus://auth/handoff`.
- No caller manually concatenates callback URLs.

### `deploy/supabase/verify-auth-redirects.sh`

Capability: read hosted Supabase Auth URL config and verify it matches the repo
env contract.

Rules:

- Read-only.
- Redacted output.
- Fails nonzero on drift.
- Runs before production deploy and in post-deploy verification.

## API And Env Design

Environment variables:

```text
APP_PUBLIC_URL=https://app.example.com
AUTH_ALLOWED_REDIRECT_ORIGINS=https://app.example.com
AUTH_TRUSTED_PROXY_ORIGINS=
SERVER_ACTION_ALLOWED_ORIGINS=
SUPABASE_MANAGEMENT_ACCESS_TOKEN=<operator-or-ci-only, never synced>
```

Semantics:

- `APP_PUBLIC_URL`: canonical public app origin. One value.
- `AUTH_ALLOWED_REDIRECT_ORIGINS`: full URL origins allowed for app-auth
  redirect construction. Can contain multiple origins only when each is an
  intentional public app origin.
- `AUTH_TRUSTED_PROXY_ORIGINS`: full URL origins of trusted proxy hops whose
  forwarded host/proto headers may be honored.
- `SERVER_ACTION_ALLOWED_ORIGINS`: Next.js domain patterns that may invoke
  Server Actions despite a host/origin mismatch.
- `SUPABASE_MANAGEMENT_ACCESS_TOKEN`: read-only Management API credential used
  by local operator scripts or CI. It is documented in `.env.example` but is not
  part of Vercel or VPS runtime env.

Do not add:

- `NEXT_PUBLIC_SITE_URL` as a second app URL owner.
- A second redirect allowlist env var with the same meaning.
- A Supabase service-role key to Vercel.
- A production wildcard such as `https://**`.

## File Plan

Documentation:

- Keep this cutover plan in `docs/cutovers/auth-origin-and-redirect-hardening.md`;
  do not move it into the stable module docs until the implementation is done.
- Edit `docs/architecture.md` auth/deploy sections after implementation.
- Edit `deployment.md` deploy and smoke sections.
- Edit `deploy/env/README.md`.
- Edit `.env.example`.
- Edit `deploy/env/env-prod.example`.
- Edit `deploy/env/env-prod-frontend.example`.
- Optionally remove stale references to deleted cutover docs.

Frontend code:

- Add `apps/web/src/lib/security/origin.ts`.
- Add `apps/web/src/lib/security/origin.test.ts`.
- Edit `apps/web/src/lib/auth/callback-origin.ts` to use the neutral parser and
  fail strict invalid deployed env.
- Edit `apps/web/src/lib/auth/callback-origin.test.ts`.
- Edit `apps/web/src/lib/env.ts` or add a sibling env module for
  `SERVER_ACTION_ALLOWED_ORIGINS`.
- Edit `apps/web/next.config.ts` to set
  `experimental.serverActions.allowedOrigins` from validated config only when
  non-empty.
- Edit `apps/web/src/app/extension/connect/start/route.ts` to reuse the neutral
  parser for `NEXUS_EXTENSION_REDIRECT_ORIGINS` without changing extension
  policy.
- Add or extend tests for OAuth start, email-change Server Action, callback
  route, extension redirect parsing, and env validation.

Deploy and smoke:

- Edit `deploy/vercel/sync-env.sh` to validate
  `SERVER_ACTION_ALLOWED_ORIGINS` and reject forbidden backend/provider keys.
- Edit `deploy/hetzner/sync-env.sh` only if shared env validation moves or new
  shared keys are introduced.
- Add `deploy/supabase/verify-auth-redirects.sh`.
- Add `deploy/smoke/auth-redirect-construction-smoke.sh` as a separate explicit
  redirect-construction smoke wrapper. Keep `make smoke` mapped to the safe GET
  auth health check.
- Update `Makefile` with a narrow target only if the command becomes stable
  enough to be part of the repo command surface.

Local Supabase:

- Keep `supabase/config.toml` local redirect URLs exact.
- Do not use local wildcard policy as production precedent.

## Implementation Plan

1. Introduce the neutral origin parser.
   - Add pure parser tests first.
   - Update auth, extension, and frontend env validation to use it where their
     syntax rules match.
   - Keep policy decisions in existing owners.

2. Add strict deployment validation.
   - Validate `AUTH_ALLOWED_REDIRECT_ORIGINS` in deployed builds.
   - Add and validate `SERVER_ACTION_ALLOWED_ORIGINS`.
   - Update `.env.example` and deploy env examples.
   - Update Vercel sync validation and readback checks.

3. Wire Next.js Server Action allowed origins.
   - Parse the validated domain-pattern list in `next.config.ts`.
   - Set `allowedOrigins` only when non-empty.
   - Add tests around the parser/validator rather than testing Next internals.

4. Add Supabase hosted Auth redirect verifier.
   - Implement read-only Management API fetch.
   - Compare site URL and exact callback URLs.
   - Reject production wildcards.
   - Document the required token and least-privilege expectations.

5. Add redirect-construction tests and smoke.
   - Strengthen Server Action and OAuth constructor tests.
   - Add staging deployed canary flow.
   - Add production explicit mode: read-only verifier or isolated canary.
   - Ensure no smoke secret or token appears in output.

6. Update docs and deployment runbooks.
   - Clarify direct Vercel custom-domain behavior versus host-rewriting proxy
     behavior.
   - Clarify the difference between app origins, Next domain patterns, and
     Supabase exact callback URLs.
   - Replace manual dashboard checklist language with machine-verifiable gates.

7. Delete stale branches and references.
   - Remove any completed cutover-only wording that implies a parallel old path.
   - Do not keep compatibility references for old env names or local defaults in
     deployed docs.

## Acceptance Criteria

Functional:

- Server Actions still work on the current direct Vercel production topology
  with no extra `allowedOrigins`.
- In a simulated host-rewriting topology, missing
  `SERVER_ACTION_ALLOWED_ORIGINS` fails validation before deploy.
- In a simulated host-rewriting topology, the minimal configured domain pattern
  is passed to `serverActions.allowedOrigins`.
- `changeEmailAction` calls Supabase only after resolving an allowlisted origin.
- Spoofed host/forwarded headers return the public failure message and do not
  call Supabase.
- OAuth start and email-change flows both construct `/auth/callback` URLs from
  the same auth-origin and redirect-builder owners.
- `/auth/callback` re-validates origin before exchange and final redirect.

Provider verification:

- Supabase verifier passes when `site_url` equals `APP_PUBLIC_URL` and every
  `${AUTH_ALLOWED_REDIRECT_ORIGINS}/auth/callback` URL is configured.
- Supabase verifier fails on missing callback URL.
- Supabase verifier fails on production wildcard callback URL.
- Supabase verifier fails on HTTP production app origin.
- Supabase verifier fails on unreadable Management API config.
- Supabase verifier redacts secrets and does not print tokens.

Env and deploy:

- Every new env var is documented in `.env.example`.
- Vercel env sync requires and verifies every non-sensitive required frontend
  key.
- Vercel env sync keeps Management API credentials out of Vercel.
- Backend env sync does not inherit frontend-only keys unless explicitly needed.
- `next build` fails for invalid deployed auth origin env.

Tests:

- `make test-front-unit` covers parser, auth-origin, redirect-construction, and
  env validation.
- Relevant existing auth tests keep passing:
  `callback-origin.test.ts`, `redirects.test.ts`, `callback.test.ts`,
  OAuth route tests, and account action tests.
- `make test-e2e` or a targeted Playwright lane covers local Supabase
  email-change redirect behavior.
- The deployed smoke command has an explicit staging mutating mode and
  production mode.

Grep/ownership:

- No route or Server Action manually constructs Supabase auth callback URLs.
- No app code outside `callback-origin.ts` reads `x-forwarded-host` for auth
  redirect-origin policy.
- No app code outside `redirects.ts` owns auth callback URL construction.
- No production docs instruct operators to rely only on Supabase dashboard
  inspection.

## Key Decisions

- Direct Vercel custom domains are same-origin Server Action deployments. Do not
  add `allowedOrigins` unless the observed host/origin relationship actually
  diverges.
- Host-rewriting proxies require `SERVER_ACTION_ALLOWED_ORIGINS`; that list is a
  Next.js admission list and is deliberately separate from redirect allowlists.
- `AUTH_ALLOWED_REDIRECT_ORIGINS` remains full URL origins because app redirect
  construction needs scheme and port.
- Supabase production redirect URLs are exact callback URLs because Supabase's
  own docs recommend exact production redirect paths.
- The Supabase verifier is read-only. A future "apply" command would need its
  own audited spec and explicit operator confirmation.
- The extension redirect allowlist can reuse neutral parsing, but it must not
  import auth callback policy.
- Production smoke either uses isolated canary infrastructure or stays read-only
  by design. Silent skip is not acceptable.

## Composition With Other Systems

- Supabase Auth remains Auth-only. The app still does not use Supabase Database
  or Storage in production.
- FastAPI continues to verify Supabase-issued JWTs through JWKS and does not own
  redirect URL construction.
- Android native Google sign-in still posts to `/auth/native/google` and receives
  handoff codes; browser OAuth and email-change redirect policy stays server-side.
- Browser extension connect flow keeps a separate extension redirect policy but
  can share neutral origin syntax parsing.
- CSP connect-origin parsing remains a separate policy because it governs
  browser network destinations, not auth redirect targets.
- Vercel env sync remains the frontend control-plane gate. Supabase Management
  API verification is added beside it, not hidden inside runtime code.

## SME Checks Before Implementation

- What exact frontend topology is being deployed today: direct Vercel custom
  domain, Vercel preview, or host-rewriting proxy in front of Vercel?
- What host does Next.js observe for a real Server Action POST in each topology?
- Are all app public origins intentional, canonical, and HTTPS-only?
- Does Supabase hosted Auth config contain exact `/auth/callback` URLs for every
  app origin?
- Is the smoke flow proving the real owner, or only a local helper?
- Which secret is needed to verify provider config, and can it be kept out of
  runtime env?
- Are we broadening any CSRF or redirect allowlist because it is convenient
  rather than because the topology requires it?
- Can every failure happen before deploy promotion instead of at first user
  interaction?

## Verification Commands

Narrow local verification after implementation:

```bash
make test-front-unit
make test-e2e PLAYWRIGHT_ARGS="tests/auth-redirect-construction.spec.ts"
make test-e2e PLAYWRIGHT_ARGS="tests/password-auth.spec.ts"
./deploy/supabase/verify-auth-redirects.sh --env-file deploy/env/env-prod --frontend-env-file deploy/env/env-prod-frontend
./deploy/smoke/auth-smoke.sh
./deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly
```

Run broader gates only when the implementation touches shared env validation,
Next config, or smoke command surfaces enough to justify them.
