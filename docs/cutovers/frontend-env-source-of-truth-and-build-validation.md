# Frontend Environment Source-of-Truth & Build-Time Validation — Cutover Spec

Status: **implemented + review-refined** (2026-06-02) · Owner: web · Type: hard cutover (no
legacy, no fallbacks, no back-compat) · Created: 2026-06-02 · See §17 for post-review refinements

> Trigger: a near-miss reconstruction of the 2026-06-01 prod outage (hotfixed by the fail-open
> guard in `edd4c4ba`, then behaviorally re-armed by `ccfc2d0a` — not a literal git revert). The
> frontend has **no single source of truth for "environment"**: the
> deployment axis (`NEXUS_ENV`) and the build/run axis (`NODE_ENV`) are read inline, ad hoc,
> in seven places, and were once conflated inside one predicate. That conflation 500'd the
> whole site. The predicate was fixed, but (a) the strict env check still throws **per request
> inside middleware** — re-arming the original outage footgun — and (b) nothing structurally
> prevents the two axes from being confused again. This cutover centralizes environment
> resolution into one typed, validated, frozen module and moves the strict check to **build
> time**, where a misconfiguration fails the *deploy* instead of every *request*.

## 1. Summary

Today the Next.js app decides "what environment am I in?" by reading `process.env.NODE_ENV`
and `process.env.NEXUS_ENV` directly at seven call sites, with hand-rolled comparisons and
no shared types. Two of those reads are the *same question* asked of the *wrong variable*:
`NODE_ENV` answers "is this a dev or production **build**" (and `next start` forces it to
`"production"` regardless of where the code is deployed), while `NEXUS_ENV` answers "is this
**deployed** to local / test / staging / prod". The original CSP code conflated them
(`isProduction = NODE_ENV === "production" || NEXUS_ENV === "prod"`), so the E2E production
build tripped the production branch, ignored `E2E_DISABLE_CSP=1`, built the CSP, threw on the
not-yet-set connect-origin env, and 500'd every route. The hotfix `edd4c4ba` added a fail-open
catch; `ccfc2d0a` then correctly narrowed `isProduction` to `NEXUS_ENV === "prod"` — but in the
same commit it
**deleted the fail-open catch and introduced a new required prod env var** (`R2_S3_API_ORIGIN`),
so the strict throw now lives, uncaught, in per-request middleware again, guarded only by the
assumption that the Vercel env is always set before traffic arrives. It is not: the frontend
deploys via Vercel git integration while env is pushed by a **manual, unordered**
`deploy/vercel/sync-env.sh`/dashboard step.

This cutover:

1. Creates `apps/web/src/lib/env.ts` — the **single source of truth** for environment
   resolution. Two clearly-named axes (`NexusEnv` deployment, `NODE_ENV` build mode), typed
   predicates, and one resolved/validated/frozen config object computed once per process. It
   mirrors the backend's proven `python/nexus/config.py` pattern (`Environment` enum +
   `@model_validator` + `@lru_cache get_settings()`), which the frontend currently has no
   equivalent of.
2. Moves the strict connect-origins validation to **build time** via a top-level
   `assertDeploymentEnv()` call in `next.config.ts`. A deployed build (`staging`/`prod`) with
   missing/invalid origins fails `next build` → Vercel never promotes the artifact → the
   last-good deployment keeps serving. This converts a site-wide per-request outage into a
   blocked deploy: fail-loud **and** zero-downtime.
3. Removes the per-request throw and the per-request env recompute from middleware; the
   builder reads the memoized resolved config.
4. **Consolidates every environment-mode read and deployment env var** (build/run axis,
   deployment axis, connect origins, internal-API config) in `apps/web` through `lib/env.ts`,
   and deletes `lib/api/internal-config.ts`, the private `isProduction()` in `csp.ts`, and the
   inline `process.env.NODE_ENV`/`NEXUS_ENV` comparisons in middleware, theme, and contributor
   code. (Supabase service config is a separate concern — see §4.)
5. Pins the decoupling with a regression test: `NODE_ENV=production` + `NEXUS_ENV=test` +
   `E2E_DISABLE_CSP=1` ⇒ CSP disabled — the exact condition that the original bug got wrong.

It is a **hard cutover**: no parallel old/new predicates, no fallbacks, no back-compat. The
ad-hoc reads are deleted, not kept alongside.

## 2. Context (audit findings, grounded)

| # | Finding | Evidence |
|---|---|---|
| A | Strict connect-origins check throws **uncaught, per request** in middleware; no boot/build guard | `apps/web/src/middleware.ts:38-52` → `apps/web/src/lib/security/csp.ts:164-205` |
| B | Blast radius is total: matcher covers all non-static routes; Next has no middleware error boundary | `apps/web/src/middleware.ts:60-71` |
| C | The throw fires fresh on every request (not memoized) | `apps/web/src/middleware.ts:39` |
| D | No build-time or boot-time env validation exists (no `instrumentation.ts`, no `next.config` check, no readiness route) | repo-wide: none; `apps/web/next.config.ts:1-55` |
| E | Deploy model is unordered: git-integration code deploy vs. manual `sync-env.sh`/dashboard env | `deploy/hetzner/README.md:93` ("Do not run a manual `vercel deploy --prod` … integration"); `sync-env.sh` referenced by no workflow (`.github/workflows/` = `ci.yml`, `android-release.yml` only) |
| F | `ccfc2d0a` bundled the highest-risk change class: re-armed the throw **and** added a new required prod var (`R2_S3_API_ORIGIN`) | `git show ccfc2d0a -- apps/web/src/middleware.ts apps/web/src/lib/security/csp.ts` |
| G | No single env source of truth: `NODE_ENV` read inline at 7 sites across 4 files; `NEXUS_ENV` read in exactly 1 (private) place | see table below |
| H | `isProduction()` is private to `csp.ts`, unreusable; `internal-config.ts` re-derives prod-ness off the *wrong* axis (`NODE_ENV`) | `csp.ts:130-132`, `internal-config.ts:9,19` |
| I | Spec drift: the CSP cutover doc still re-conflates the two axes in prose | `docs/cutovers/csp-and-security-headers-hardening.md:181` |

Current environment **mode** reads (predicates this cutover absorbs):

| Site | Code | Axis it *means* | Today |
|---|---|---|---|
| `csp.ts:130-132` | `NEXUS_ENV === "prod"` (`isProduction()`) | deployment | private, unreusable |
| `csp.ts:152,171,176,187,193,198,220` | `isProduction()` calls | deployment | gates connect-origin strictness + E2E bypass |
| `middleware.ts:40` | `NODE_ENV === "development"` | build mode | inline |
| `internal-config.ts:9` | `NODE_ENV === "production" ? "" : "http://localhost:8000"` | **should be deployment** | conflation (latent bug) |
| `internal-config.ts:19` | `NODE_ENV !== "production"` (tolerate missing secret) | **should be deployment** | conflation (latent bug) |
| `setAppearanceAction.ts:16` | `secure: NODE_ENV === "production"` | **should be deployment (HTTPS)** | conflation (latent bug: `next start` local E2E is `NODE_ENV=production` over HTTP → cookie dropped) |
| `ContributorChip.tsx:48,61,86` | `NODE_ENV !== "production"` (dev-only throws) | build mode | inline ×3 (**client component**) |

Raw deployment-value/config reads the same module absorbs (so the audit is complete, not just
predicates):

| Site | Read | Destination |
|---|---|---|
| `csp.ts:167` | `FASTAPI_BASE_URL` | `lib/env.ts` (`connectOrigins` + `internalApi.fastApiBaseUrl`) |
| `csp.ts:182` | `R2_S3_API_ORIGIN` | `lib/env.ts` (`connectOrigins`) |
| `internal-config.ts:10` | `NEXUS_INTERNAL_SECRET` | `lib/env.ts` (`internalApi.internalSecret`; **required when `isDeployed()`**) |
| `csp.ts:221` | `E2E_DISABLE_CSP` | `lib/env.ts` (`disableCspForE2E`) |
| `next.config.ts:51` | `E2E_DISABLE_NEXT_DEV_INDICATOR` | stays in `next.config.ts` (a build-local dev-indicator toggle, used nowhere else); newly documented in `.env.example` (§12) |

Runtime facts that constrain the design (from code, not guessed):

- **`next start` forces `NODE_ENV=production`.** Every E2E server (`make web-e2e`,
  `Makefile:225-226`) and the strict-CSP profile (`e2e/playwright.csp.config.ts:77`) run a
  production build. So `NODE_ENV` is `"production"` in test runs that are emphatically *not*
  the prod deployment — this is precisely why the two axes must be separate.
- **`NEXUS_ENV` is the deployment axis** and already an enum on the backend
  (`python/nexus/config.py:57-63` `Environment = {local,test,staging,prod}`). The frontend
  uses the same four values (`make web-e2e` → `test`; real-media → `local`; `env-prod.example:4`
  → `prod`).
- **The connect-origin env vars are non-secret, shared, and available at build.**
  `FASTAPI_BASE_URL` (`env-prod-frontend.example:4`) and `R2_S3_API_ORIGIN`
  (`env-prod.example:28`) are origin-only public values listed in the Vercel required-keys set
  (`deploy/vercel/sync-env.sh:11-24`). Vercel injects project env into the **build**
  environment, so a build-time assertion can see them and fail the build when they are absent.
- **The backend already validates required env at boot and fails the process**, not the
  request: `@model_validator(mode="after")` on `Settings` (`config.py:413+`), instantiated once
  via `@lru_cache get_settings()` (`config.py:704-715`), strict for `staging`/`prod`
  (`requires_internal_header`, `config.py:663-666`). This is the pattern to mirror.

## 3. Goals

1. **One source of truth (per axis).** `lib/env.ts` is the only reader of `NEXUS_ENV` and the
   deployment env vars; `lib/build-mode.ts` is the only reader of `NODE_ENV`. No other frontend
   file reads `process.env.NEXUS_ENV` or compares `process.env.NODE_ENV`.
2. **Two axes, never conflated.** Deployment env (`NexusEnv`) and build mode (`NODE_ENV`) are
   distinct, distinctly-named, typed. It is structurally impossible to ask "am I in prod?" and
   accidentally read the build flag.
3. **Fail the deploy, not the request.** A `staging`/`prod` build with missing/invalid
   connect-origin env fails `next build`; the bad deployment is never promoted; the live site
   never serves a 500 for this class of misconfiguration.
4. **No per-request env work.** Connect origins are resolved, validated, and frozen once per
   process; middleware reads the cached value.
5. **Consolidate the strays.** `internal-config.ts` is absorbed; the theme cookie `secure`
   flag and contributor dev-assertions route through typed helpers; the latent `NODE_ENV`
   conflations they contain are fixed in passing.
6. **Pin the regression.** A test asserts the exact `NODE_ENV=production` + `NEXUS_ENV=test`
   matrix so the original bug cannot silently return.

## 4. Non-goals

- **A runtime readiness probe / health route.** The build-time gate is the guard; a
  `/healthz` that re-checks env at runtime would be a second source of truth for the same
  invariant. Out.
- **`instrumentation.ts` boot validation.** A throw in `register()` (or per request) still
  500's a live instance — it does not prevent promotion. Build-time is strictly better for
  this failure mode. If a future required var is *runtime-only* (not exposed to the build),
  revisit; today all connect-origin vars are build-visible (§2). Out for now.
- **Backend config changes.** `python/nexus/config.py` already validates at boot; this cutover
  mirrors its *pattern*, not its code, and does not touch it. (Its god-file split is tracked
  separately in `docs/cutovers/codebase-cleanliness-audit.md:2812+` and is out of scope here.)
- **Centralizing non-env constants.** `lib/env.ts` owns environment resolution only, not
  arbitrary app constants.
- **Changing CSP policy content.** The directive set, nonce flow, and reporting are unchanged;
  this cutover only moves *where env is read and validated*. `csp.ts` keeps its policy data and
  pure builder.
- **Re-introducing a request-time fallback.** No fail-open catch returns. Per the no-fallback
  rule, validity is guaranteed upstream (build gate); middleware assumes it.
- **Consolidating the Supabase public env reads** (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` in
  `lib/supabase/server.ts`, `route-handler.ts`, `lib/auth/refresh.ts`, `session-cookie.ts`,
  `auth/signout/route.ts`). This is Supabase **service config**, a different concern from
  environment-mode detection, and `NEXT_PUBLIC_*` values must stay referenceable as literals for
  Next's build-time inlining. Observed adjacent duplication; flagged for a separate
  `lib/supabase/config.ts` cleanup, not bundled into this env-mode cutover.
- **Reworking `sync-env.sh` into CI.** Automating env provisioning in the deploy pipeline is a
  separate ops improvement; this cutover makes the *app* safe regardless of provisioning order.

## 5. Key decisions (with rationale)

1. **Two named axes in one module.** `NexusEnv` (`local|test|staging|prod`) for deployment;
   `isDevBuild()`/`isProdBuild()` for `NODE_ENV`. The names encode the distinction so a reader
   never has to remember which variable means what. The root cause of the outage was that the
   distinction lived only in a developer's head.
2. **Validation at build time via `next.config.ts`.** `next.config.ts` is evaluated by
   `next build`, already imports TS from `src/lib/security` (`next.config.ts:2`), and a throw
   there aborts the build. A failed build is never promoted, so the prior good deployment keeps
   serving — the only layer that converts "missing env" into "blocked deploy" rather than "site
   down". Chosen over a `scripts/*.mjs` prebuild (can't import the TS source of truth without
   duplicating logic) and over `instrumentation.ts`/per-request (both still 500 a live
   instance).
3. **Strictness gated on `isDeployed()` = `staging || prod`, not `prod` only.** The backend
   already requires R2/secret in both staging and prod (`config.py:663-666`). Staging must also
   have valid connect origins or its CSP is wrong. This widens the current `prod`-only throw —
   a deliberate, documented behavior change.
4. **Resolve-once, frozen singleton with a test reset.** `getEnv()` memoizes a frozen
   `ResolvedEnv`; `__resetEnvForTests()` clears it. Direct port of `@lru_cache get_settings()` +
   `clear_settings_cache()` (`config.py:704-716`). Eliminates per-request recompute
   (`middleware.ts:39`) and makes validation testable without eager import-time throws.
5. **`csp.ts` becomes pure policy.** `isProduction()`, `parseConnectOrigin()`,
   `getConnectOriginsFromEnv()`, and `shouldDisableCspForE2E()` (all env-reading) move to
   `lib/env.ts`. `csp.ts` keeps `CSP_DIRECTIVES`, `buildContentSecurityPolicy`, `generateNonce`,
   `buildReportingEndpoints` — pure, env-free, runtime-agnostic. Clean separation: `env.ts`
   resolves environment; `csp.ts` serializes policy.
6. **Absorb `internal-config.ts` and fix its conflation.** `getInternalApiConfig` /
   `isInternalApiConfigured` become `getEnv().internalApi` / `isInternalApiUsable()`, with the
   "tolerate missing secret / default to localhost" branch keyed on `isDeployed()` (deployment)
   instead of `NODE_ENV` (build). Delete the file.
7. **Fix the theme-cookie `secure` flag.** `secure: NODE_ENV === "production"` →
   `secure: isDeployed()`. Today `next start` local E2E (`NODE_ENV=production`, HTTP localhost)
   sets `secure: true` and the browser drops the cookie; tying it to deployment (HTTPS) fixes
   that latent bug.
8. **Contributor dev-assertions stay on the build axis, behind a helper.** `NODE_ENV !==
   "production"` → `!isProdBuild()` — identical behavior (dev + vitest throw; production build
   returns null), but routed through the typed module. These are genuinely *build-mode*
   developer assertions, so the build axis is the correct home; no behavior change.
9. **No default-to-prod surprise; mirror the backend default.** Unset `NEXUS_ENV` → `local`
   (as `config.py:78` defaults to `LOCAL`); an unrecognized value → throw (fail fast).
   `NEXUS_ENV` is in the Vercel required-keys set, so prod always sets it explicitly.
10. **`E2E_DISABLE_CSP` is honored only outside deployed envs.** `disableCspForE2E =
    !isDeployed() && E2E_DISABLE_CSP === "1"`. Both staging **and** prod can never disable CSP
    (consistent with decision 3's strict-staging gate); local/test honor the flag. E2E only ever
    runs as `test`/`local`, so every E2E flavor still honors it. (Using `!isProd()` here would
    have let staging disable CSP — the contradiction the matrix in §8 would otherwise expose.)
11. **Client/server split: `lib/build-mode.ts` vs `lib/env.ts`.** `ContributorChip` is a Client
    Component (`"use client"`) and the *only* client reader of `process.env`. Importing the
    deploy-config module — which owns `NEXUS_INTERNAL_SECRET` — into a client bundle is a
    bundle-boundary risk. So the `NODE_ENV` build-mode helpers live in a tiny client-safe
    `lib/build-mode.ts` (only `process.env.NODE_ENV`, which Next statically inlines; no secrets,
    no `NEXUS_ENV`); `lib/env.ts` re-exports them for server ergonomics. `lib/env.ts` cannot use
    `import "server-only"` (it is imported by `next.config.ts`, a Node build context where
    `server-only` throws), so the boundary is enforced by the split plus a guard test asserting
    no `"use client"` file imports `@/lib/env` (§14, §16).

## 6. Architecture & final state

```
apps/web/
├─ src/lib/build-mode.ts          ← NEW: client-safe NODE_ENV helpers (isDevBuild/isProdBuild).
│                                    No secrets, no NEXUS_ENV — importable from Client Components.
├─ src/lib/env.ts                 ← NEW: server/deploy source of truth (NEXUS_ENV axis,
│                                    resolved+validated+frozen config incl. NEXUS_INTERNAL_SECRET,
│                                    connect-origin parsing, build-time assert). Re-exports the
│                                    build-mode helpers for server ergonomics. Server-only by use.
├─ src/lib/env.test.ts            ← NEW: axis-decoupling + validation + regression tests
│                                    (+ guard: no `"use client"` file imports `@/lib/env`)
│
├─ src/lib/security/csp.ts        ← MODIFIED: env-reading helpers REMOVED (moved to env.ts);
│                                    keeps CSP_DIRECTIVES + pure builders + nonce + reporting
├─ src/lib/security/csp.test.ts   ← MODIFIED: env-validation cases move to env.test.ts;
│                                    keeps policy/CSP-Evaluator assertions
│
├─ src/middleware.ts              ← MODIFIED: reads getEnv().connectOrigins / .disableCspForE2E;
│                                    isDev → isDevBuild(); no per-request throw, no recompute
├─ src/lib/supabase/middleware.test.ts ← MODIFIED: "throws when env missing in prod" test
│                                    retargets to the build-time gate; disable-flag test pins
│                                    NODE_ENV=production + NEXUS_ENV=test
│
├─ next.config.ts                 ← MODIFIED: top-level assertDeploymentEnv() (build-time gate)
│
├─ src/lib/api/internal-config.ts ← DELETED: folded into lib/env.ts (getEnv().internalApi)
├─ src/lib/theme/setAppearanceAction.ts ← MODIFIED: secure: isDeployed()
└─ src/components/contributors/ContributorChip.tsx ← MODIFIED: !isProdBuild() ×3 (from build-mode.ts)

docs/cutovers/csp-and-security-headers-hardening.md ← MODIFIED: §Decision-8 line 181 de-conflated
.env.example                      ← MODIFIED: document NODE_ENV + E2E_DISABLE_NEXT_DEV_INDICATOR (§12)
```

Build-time gate (the new guard):

```
next build  (Vercel build env has NEXUS_ENV=prod + FASTAPI_BASE_URL + R2_S3_API_ORIGIN
             + NEXUS_INTERNAL_SECRET)
  → loads next.config.ts
      → assertDeploymentEnv()
          → getEnv()                       // resolves + validates, memoized (in the build process)
              → isDeployed()? require + validate FASTAPI_BASE_URL, R2_S3_API_ORIGIN,
                              NEXUS_INTERNAL_SECRET
          → missing/invalid → throw  → `next build` FAILS  → artifact never produced
                                                            → Vercel keeps last-good deploy
          → valid           → build proceeds; the artifact is promotable. The runtime process is
                              SEPARATE: it resolves its own frozen ResolvedEnv once, on first
                              getEnv(); the build gate guarantees that same env validates.
```

Request-time flow (no env work, no throw):

```
middleware(request)
  → nonce = generateNonce()
  → env  = getEnv()                         // resolves once per runtime process, then returns
                                            //   the frozen copy (build gate already guaranteed
                                            //   this env validates)
  → csp  = env.disableCspForE2E
             ? null
             : buildContentSecurityPolicy({ nonce,
                                            isDev: isDevBuild(),
                                            isHttpsRequest,
                                            connectOrigins: env.connectOrigins })
  → response = updateSession(request, nonce, csp)
  → if csp: set Content-Security-Policy + Reporting-Endpoints
```

## 7. Capability contract / API design (`lib/env.ts`)

`lib/env.ts` is **server/deploy config** (it owns `NEXUS_INTERNAL_SECRET` and the deployment
axis): import it from middleware, server components, server actions, route handlers, and
`next.config.ts` — **never from a Client Component**. The `NODE_ENV` build-mode helpers a client
needs live in the separate client-safe `lib/build-mode.ts`. (`lib/env.ts` is *not* marked
`import "server-only"` because `next.config.ts` imports it and `server-only` throws in the Node
build context; the boundary is enforced by the split + a guard test, §16.) Both modules are
runtime-agnostic (no Node-only APIs).

```ts
// ── lib/build-mode.ts — CLIENT-SAFE. Reads only process.env.NODE_ENV (statically inlined by
//    Next). No secrets, no NEXUS_ENV. Importable from Client Components.
export function isDevBuild(): boolean;   // NODE_ENV === "development"
export function isProdBuild(): boolean;  // NODE_ENV === "production"
```

```ts
// ── lib/env.ts — SERVER/DEPLOY config. Single source of truth for the deployment axis.
//    Two orthogonal axes, never conflated:
//      • Deployment env (NEXUS_ENV):  local | test | staging | prod
//      • Build/run mode (NODE_ENV):   re-exported from build-mode.ts (next start forces production)
export { isDevBuild, isProdBuild } from "./build-mode";   // re-exported for server ergonomics

export type NexusEnv = "local" | "test" | "staging" | "prod";

// Deployment axis (NEXUS_ENV)
/** Parsed once. Unset → "local" (mirrors backend default). Unknown value → throws. */
export function nexusEnv(): NexusEnv;
/** staging || prod. The "strict requirements / served over HTTPS" gate. */
export function isDeployed(): boolean;   // §17: per-env isLocal/isTest/isStaging/isProd dropped (unused)

// Resolved, validated, frozen config (mirrors backend get_settings())
export interface ResolvedEnv {
  readonly nexusEnv: NexusEnv;
  /** FastAPI/SSE origin + presigned R2 origin. Origin-only, deduped, validated. */
  readonly connectOrigins: readonly string[];
  readonly internalApi: {
    readonly fastApiBaseUrl: string;
    readonly internalSecret: string;   // required (non-empty) when isDeployed()
  };
  /** (!isDeployed()) && E2E_DISABLE_CSP === "1". staging & prod can never disable CSP. */
  readonly disableCspForE2E: boolean;
}
/** Resolves + validates once; returns a frozen object. Memoized within the current process. */
export function getEnv(): ResolvedEnv;

// Build-time gate
/** Called at next.config eval. On a deployed build (staging|prod) with missing/invalid
 *  FASTAPI_BASE_URL, R2_S3_API_ORIGIN, or NEXUS_INTERNAL_SECRET, throws → fails `next build`
 *  → the deploy is never promoted. No-op for local/test builds. */
export function assertDeploymentEnv(): void;

// §17: the `isInternalApiUsable()` BFF helper was removed in post-implementation review — the
// build gate + localhost default make "BFF not usable" unreachable; callers read getEnv().internalApi
// directly and trust the invariant (see §17).

// Test seam
/** Clears the memo so vi.stubEnv() takes effect (mirrors clear_settings_cache). */
export function __resetEnvForTests(): void;
```

Guarantees / invariants the contract enforces:

- `nexusEnv()` returns one of exactly four literals or throws; never an arbitrary string.
- The deployment predicates derive **only** from `NEXUS_ENV`; the build predicates derive
  **only** from `NODE_ENV`. No function reads both.
- `connectOrigins` are origin-only (no path/query/fragment), HTTPS unless localhost or
  `!isDeployed()`, deduped. In `isDeployed()`, `FASTAPI_BASE_URL`, `R2_S3_API_ORIGIN`, **and**
  `NEXUS_INTERNAL_SECRET` are required, and `R2_S3_API_ORIGIN` must end in
  `.r2.cloudflarestorage.com`; otherwise `getEnv()` throws. (Parity with the backend, which
  requires the internal secret for staging/prod, `config.py:485`.)
- `getEnv()` is pure given `process.env` and idempotent within a single process (frozen,
  memoized). The build process and the runtime process are distinct: each resolves its own copy
  once; the build gate guarantees the runtime resolution validates.
- `assertDeploymentEnv()` is a no-op unless `isDeployed()`; it never throws for a local/test
  build, so `next dev`, `make build` (local), and the E2E production build are unaffected.
- `disableCspForE2E` is `false` whenever `isDeployed()` (staging **and** prod), independent of
  `NODE_ENV` and the flag.

## 8. Target behavior (the env matrix, exact)

| Context | `NEXUS_ENV` | `NODE_ENV` | `isProd()` | `isDeployed()` | `isDevBuild()` | `getEnv()` connect-origins | `disableCspForE2E` | `assertDeploymentEnv()` |
|---|---|---|---|---|---|---|---|---|
| `next dev` (local) | `local` | `development` | false | false | true | localhost allowed, missing tolerated | `E2E_DISABLE_CSP==="1"` | no-op |
| `make web-e2e` (default E2E) | `test` | `production` | **false** | false | false | localhost allowed | **`true`** (flag set) | no-op |
| real-media E2E | `local` | `production` | false | false | false | localhost allowed | `true` (flag set) | no-op |
| strict-CSP E2E | `test` | `production` | false | false | false | localhost allowed (`R2_S3_API_ORIGIN`=MinIO) | `false` (flag `0`) | no-op |
| **staging deploy** | `staging` | `production` | false | **true** | false | **required + validated** | `false` (gated by `isDeployed`) | **validates origins + secret** |
| **prod deploy** | `prod` | `production` | **true** | **true** | false | **required + validated** | `false` (gated by `isDeployed`) | **validates origins + secret** |

The row that encodes the original bug is **`make web-e2e`**: `NODE_ENV=production` must **not**
make `isProd()` true, so `E2E_DISABLE_CSP=1` is honored and the CSP builder is never reached.
This is the regression-test row (§14).

## 9. Composition with other systems

- **Next.js build (Vercel):** `next build` evaluates `next.config.ts` with the project's
  production env injected. `assertDeploymentEnv()` runs there; a missing/invalid origin aborts
  the build. Vercel only promotes successful builds, so the last-good deployment continues to
  serve — the deploy fails loudly, the site stays up. (Requires the connect-origin vars to be
  present in the **build** environment scope, which they are: non-secret shared origins in the
  required-keys set, `sync-env.sh:11-24`.)
- **Middleware / CSP:** `middleware.ts` and `csp.ts` consume `getEnv()` and `isDevBuild()`.
  The CSP policy, nonce propagation, and reporting are unchanged (`docs/cutovers/csp-and-security-headers-hardening.md`).
  `csp.ts` no longer reads env, so it is trivially unit-testable as a pure function.
- **BFF / FastAPI:** `internal-config.ts`'s consumers (the server-side proxy callers) switch to
  `getEnv().internalApi` and `isInternalApiUsable()`. The localhost default and
  missing-secret tolerance now correctly track `isDeployed()`.
- **Backend parity:** `lib/env.ts` is the frontend mirror of `python/nexus/config.py`. Same
  `NexusEnv` values, same boot/validate-once discipline, same staging/prod strictness, same
  test-reset seam. A reader who knows one understands the other.
- **`sync-env.sh`:** unchanged. It validates the env *file* operators push to Vercel; the new
  build gate validates the env the *build* actually sees. They are complementary (file
  pre-flight vs. build enforcement), not redundant.
- **Tests:** `env.test.ts` owns the matrix; `csp.test.ts` keeps policy assertions;
  `middleware.test.ts` keeps wiring assertions. Each env case uses `__resetEnvForTests()` +
  `vi.stubEnv()` in `beforeEach`.

## 10. Consolidation / dedup (the "reuse/centralize" ask)

| Today | After |
|---|---|
| `isProduction()` private in `csp.ts:130-132` | `isProd()` exported from `lib/env.ts` (only definition) |
| `parseConnectOrigin` + `getConnectOriginsFromEnv` in `csp.ts:139-205` | moved verbatim into `lib/env.ts`, feeding `ResolvedEnv.connectOrigins` |
| `shouldDisableCspForE2E()` in `csp.ts:219-222` | `ResolvedEnv.disableCspForE2E` |
| `getInternalApiConfig`/`isInternalApiConfigured` in `internal-config.ts` (file) | `getEnv().internalApi` (callers trust the invariant; **file deleted**, and §17 removed the interim `isInternalApiUsable()` helper) |
| `NODE_ENV === "development"` inline (`middleware.ts:40`) | `isDevBuild()` |
| `NODE_ENV === "production"` for cookie `secure` (`setAppearanceAction.ts:16`) | `isDeployed()` (latent bug fixed) |
| `NODE_ENV !== "production"` ×3 (`ContributorChip.tsx`) | `!isProdBuild()` ×3 (from client-safe `lib/build-mode.ts`) |
| `NEXUS_INTERNAL_SECRET` read in `internal-config.ts:10` | `getEnv().internalApi.internalSecret` (required when `isDeployed()`) |
| per-request `getConnectOriginsFromEnv()` (`middleware.ts:39`) | resolved once, memoized (`getEnv()`) |

Pattern reused, not reinvented: the **backend** `config.py` enum + validate-once-at-boot +
`@lru_cache` singleton + `clear_settings_cache()` test seam is copied structurally into
`lib/env.ts`. Net deletion of one file and seven inline `process.env` comparisons; net
addition of one typed module with one validated read path per value (the audit's "one access
path per value" rule, `codebase-cleanliness-audit.md:2820-2826`).

## 11. Scope

**In scope:** create `lib/env.ts` (+ test); move all env-reading out of `csp.ts`; add the
build-time gate in `next.config.ts`; delete `internal-config.ts` and migrate its callers;
fix the theme-cookie and contributor `NODE_ENV` reads; retarget the middleware "throws when
env missing" test to the build gate; pin the regression matrix; de-conflate the one stale CSP
doc line.

**Out of scope:** CSP policy content; backend config; `sync-env.sh` automation; a runtime
health route; centralizing non-env constants; the `config.py` god-file split.

## 12. Files

**Created**
- `apps/web/src/lib/build-mode.ts` — client-safe `isDevBuild`/`isProdBuild` (`NODE_ENV` only).
- `apps/web/src/lib/env.ts`
- `apps/web/src/lib/env.test.ts`

**Modified**
- `apps/web/src/lib/security/csp.ts` — delete `isProduction`, `parseConnectOrigin`,
  `getConnectOriginsFromEnv`, `shouldDisableCspForE2E`; keep `CSP_DIRECTIVES`,
  `buildContentSecurityPolicy`, `generateNonce`, `buildReportingEndpoints`, `CSP_REPORT_PATH`.
  Remove the now-unused env imports.
- `apps/web/src/lib/security/csp.test.ts` — remove `getConnectOriginsFromEnv` /
  `shouldDisableCspForE2E` cases (they move to `env.test.ts`); keep `CSP_DIRECTIVES`,
  `buildContentSecurityPolicy`, `generateNonce`, `buildReportingEndpoints`, CSP-Evaluator.
- `apps/web/src/middleware.ts` — import `getEnv`, `isDevBuild` from `@/lib/env`; read
  `getEnv().connectOrigins` / `.disableCspForE2E`; delete the inline `NODE_ENV` read; no
  per-request throw.
- `apps/web/next.config.ts` — `import { assertDeploymentEnv } from "./src/lib/env"` and call it
  at module top level (before `export default`).
- `apps/web/src/lib/supabase/middleware.test.ts` — the "throws when CSP connect-origins env is
  missing in production" expectation moves to `env.test.ts` (build-gate level); the disable-flag
  test stubs `NODE_ENV=production` + `NEXUS_ENV=test` + `E2E_DISABLE_CSP=1` and asserts CSP
  omitted (header-wiring only).
- `apps/web/src/lib/theme/setAppearanceAction.ts` — `secure: isDeployed()`.
- `apps/web/src/components/contributors/ContributorChip.tsx` — `!isProdBuild()` ×3, imported
  from `@/lib/build-mode` (client-safe; must **not** import `@/lib/env`).
- `docs/cutovers/csp-and-security-headers-hardening.md` — line 181: `(NEXUS_ENV=prod/NODE_ENV=production)`
  → `(NEXUS_ENV=prod; NODE_ENV is the build axis and is irrelevant here)`.
- `.env.example` — add the two env vars read by source but currently **undocumented**, to satisfy
  `docs/rules/environment.md:9` ("every env var read by source code must appear in
  `.env.example`"): `NODE_ENV` (framework-managed — "do not set manually; `next dev`/`next start`
  own it") and `E2E_DISABLE_NEXT_DEV_INDICATOR` (test-only, optional, default unset). The other
  vars this cutover reads are already present: `NEXUS_ENV` (`:9`), `R2_S3_API_ORIGIN` (`:377`),
  `FASTAPI_BASE_URL` (`:402`), `NEXUS_INTERNAL_SECRET` (`:133`), `E2E_DISABLE_CSP` (`:430`).

**Deleted**
- `apps/web/src/lib/api/internal-config.ts` — folded into `lib/env.ts`; all importers migrate.

**Callers to migrate (mechanical):** the 7 importers of `@/lib/api/internal-config` →
`getEnv().internalApi` + `isInternalApiUsable()`: the `auth/handoff`, `auth/callback`,
`auth/native/google`, and `extension/connect/start` route handlers; `lib/api/server.ts`;
`lib/api/proxy.ts`; `lib/auth/password-flow.ts`. `proxy.ts` is repointed at the import level
only (its logic is untouched). Plus the inline mode reads in §2.

## 13. Rollout / cutover plan (hard cutover, single PR)

1. Add `lib/env.ts` (move the env-reading helpers out of `csp.ts` verbatim; add the two-axis
   predicates, the frozen `ResolvedEnv`, `assertDeploymentEnv`, `isInternalApiUsable`,
   `__resetEnvForTests`). Add `lib/env.test.ts` with the §8 matrix.
2. Strip the env helpers from `csp.ts`; repoint `middleware.ts` to `getEnv()`/`isDevBuild()`.
3. Wire `assertDeploymentEnv()` into `next.config.ts`.
4. Delete `internal-config.ts`; migrate its callers; fix `setAppearanceAction.ts` and
   `ContributorChip.tsx`.
5. Retarget the middleware tests; de-conflate the CSP doc line.
6. Verify locally:
   - `make check` (lint + types) green; **`make build` green with `NEXUS_ENV` unset/local**
     (gate is a no-op outside deployed).
   - **Negative gate proof:** `NEXUS_ENV=prod R2_S3_API_ORIGIN= FASTAPI_BASE_URL= bun run build`
     in `apps/web` **fails** with a clear connect-origins error (the build never completes).
   - **Positive gate proof:** the same with valid origins builds.
   - `make test-e2e` and `make test-csp` green (the `make web-e2e` row of §8 proves
     `E2E_DISABLE_CSP=1` is still honored under `NODE_ENV=production`).
7. Merge once all green. No phased flag, no parallel path.

## 14. Acceptance criteria

- [ ] `apps/web` contains **no** `process.env.NEXUS_ENV` read outside `lib/env.ts` and **no**
      `process.env.NODE_ENV` comparison outside `lib/build-mode.ts` (grep-clean; tests may
      `vi.stubEnv` them).
- [ ] `lib/api/internal-config.ts` is deleted; no import of it remains.
- [ ] `csp.ts` exports no env-reading function (`isProduction`/`getConnectOriginsFromEnv`/
      `shouldDisableCspForE2E` are gone); `buildContentSecurityPolicy` is pure.
- [ ] `getEnv()` returns a frozen object and is memoized; `__resetEnvForTests()` clears it.
- [ ] **Build gate (negative):** a `NEXUS_ENV=prod` (or `staging`) build with missing/invalid
      `FASTAPI_BASE_URL`, `R2_S3_API_ORIGIN`, or `NEXUS_INTERNAL_SECRET` **fails `next build`**
      with a naming error; no artifact is produced.
- [ ] **Build gate (no-op):** `make build` with `NEXUS_ENV` unset/`local`/`test` succeeds; the
      E2E production build is unaffected.
- [ ] **Regression matrix:** `env.test.ts` asserts every §8 row, including
      `NODE_ENV=production` + `NEXUS_ENV=test` + `E2E_DISABLE_CSP=1` ⇒ `disableCspForE2E === true`
      and `isProd() === false`.
- [ ] `isDeployed()` is `true` for `staging` and `prod`, `false` otherwise; connect-origin +
      secret strictness fires for both; `disableCspForE2E` is `false` for both `staging` and
      `prod` even with `E2E_DISABLE_CSP=1`.
- [ ] Middleware no longer calls `getConnectOriginsFromEnv()` per request; it reads the
      memoized `getEnv().connectOrigins`, and contains no `try/catch` fallback.
- [ ] `setAppearanceAction` sets `secure` from `isDeployed()`; the theme cookie is set over
      HTTP in local E2E.
- [ ] `ContributorChip` dev-assertions are unchanged in behavior (throw in dev/vitest, return
      null in production builds) and read `isProdBuild()` from `@/lib/build-mode`.
- [ ] **Client boundary:** no `"use client"` file imports `@/lib/env`; a guard test enforces it.
- [ ] **Env-doc compliance:** every env var read by `apps/web` source appears in `.env.example`
      (this PR adds `NODE_ENV` and `E2E_DISABLE_NEXT_DEV_INDICATOR`), per `docs/rules/environment.md`.
- [ ] `make check`, `make test-e2e`, and `make test-csp` pass; the CSP cutover doc no longer
      conflates `NODE_ENV` with `NEXUS_ENV`.

## 15. Rules / invariants (post-cutover)

1. **One source of truth (per axis).** `NEXUS_ENV` + the deploy vars are read only in
   `lib/env.ts`; `NODE_ENV` only in `lib/build-mode.ts`. Every other file asks via
   `isProd()`/`isDeployed()`/`isDevBuild()`/`getEnv()`. Never inline a
   `process.env.NEXUS_ENV`/`NODE_ENV` comparison. Client Components import `@/lib/build-mode`,
   never `@/lib/env`.
2. **Never conflate the axes.** "Am I deployed?" is `isDeployed()`/`isProd()` (`NEXUS_ENV`).
   "Is this a dev build?" is `isDevBuild()` (`NODE_ENV`). A predicate must read exactly one
   axis.
3. **Required prod env fails the build, not the request.** New required deployment env joins
   `ResolvedEnv` validation and is covered by `assertDeploymentEnv()`. No per-request throw,
   no fail-open catch.
4. **Resolve once.** Environment is read and validated a single time per process via `getEnv()`;
   no per-request env work.
5. **Staging is strict.** `isDeployed()` (staging + prod) is the strictness gate, matching the
   backend. Do not narrow it back to prod-only.
6. **Mirror the backend.** Keep `lib/env.ts` aligned with `python/nexus/config.py`'s
   `Environment` values and validate-once discipline.

## 16. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A required connect-origin var is set runtime-only (not visible to the Vercel build), so the build gate can't see it | low | All connect-origin vars are non-secret shared origins set for the production scope (build-visible); documented as a requirement (§9). If a future var is runtime-only, add an `instrumentation.ts` boot check for that var specifically. |
| `next.config.ts` evaluation throws break a non-deploy command (lint/test) | low | `assertDeploymentEnv()` is a no-op unless `isDeployed()`; lint/vitest don't load `next.config`; only `next build` does, and only staging/prod builds validate. Proven by the §13 step-6 local `make build`. |
| `lib/env.ts` (owns `NEXUS_INTERNAL_SECRET`) is imported into a client bundle | low | Client-safe `NODE_ENV` helpers live in `lib/build-mode.ts`; `ContributorChip` (the only client `process.env` reader) imports that. `lib/env.ts` can't use `server-only` (next.config imports it), so a guard test asserts no `"use client"` file imports `@/lib/env`; `make check` + the build also surface an accidental client import. |
| Behavior change: staging now throws on bad origins where prod-only did before | intended | Documented decision 3; staging must have a valid CSP. Caught by the build gate, not at runtime. |
| Behavior change: theme cookie `secure` now off in local E2E | intended | Fixes a latent bug (cookie was dropped over HTTP); covered by acceptance criteria. |
| Migration misses an `internal-config` importer (7 callers: auth handoff/callback/native-google routes, extension connect/start, `lib/api/server.ts`, `lib/api/proxy.ts`, `lib/auth/password-flow.ts`) | low | `make check` (types) fails on a dangling import; deletion is compiler-enforced. `proxy.ts` is repointed only (imports), not restructured. |
| Someone re-adds `NODE_ENV` to a deployment predicate later | med | Rule 1–2 + the §14 grep-clean criterion + the regression matrix test fail loudly. |

## 17. Post-implementation review refinements (2026-06-02)

A `docs/rules` standards review after the initial implementation removed code that the build-gate
invariant had made unreachable. These supersede the §5/§7/§9/§10 references to `isInternalApiUsable()`
and to the per-env `isLocal`/`isTest`/`isStaging`/`isProd` predicates.

- **Removed `isInternalApiUsable()` and every `if (!isInternalApiUsable())` guard** (the
  `auth/callback`, `auth/handoff`, `auth/native/google`, and `extension/connect/start` route handlers,
  plus `proxyExtensionToFastAPI`), and the equivalent `if (!config.fastApiBaseUrl)` throw in
  `lib/api/server.ts`. The predicate was provably always-true: outside deployed envs `fastApiBaseUrl`
  defaults to `http://localhost:8000` and the secret is tolerated; in a deployed env `getEnv()` throws
  on a missing URL/secret *before* the guard runs. The guards were therefore dead branches
  (cleanliness.md "delete branches for states that can no longer occur"; simplicity.md "no code paths
  for scenarios that cannot be constructed"). The "misconfigured deployed env" failure now has one
  owner — `getEnv()`'s throw, caught at build by `assertDeploymentEnv()`. `lib/auth/password-flow.ts`
  already used this trust-the-invariant posture; the routes now match it. The **reachable** DI-seam
  guard in `proxyToFastAPIWithDeps` (validates the injected `deps.config`, unit-tested in
  `proxy.test.ts`) is unchanged — it remains the single live "not configured" path.
- **Removed the unused `isLocal`/`isTest`/`isStaging`/`isProd` predicates.** Only `isDeployed()` (the
  strictness gate) and the build-mode helpers have production callers; the enum-mirror predicates had
  no caller outside the test (cleanliness.md "no test-only/unreferenced exports"; simplicity.md "no
  speculative API surface"). `nexusEnv()` is retained for the exact-env test assertions.
- **`server.test.ts`** now drives the real `getEnv()` through the `__resetEnvForTests()` +
  `vi.stubEnv()` seam instead of `vi.mock("@/lib/env", …)` (testing_standards.md §7: do not mock
  internal boundaries; the cutover had repointed the old `internal-config` mock rather than migrating
  it to the seam).
