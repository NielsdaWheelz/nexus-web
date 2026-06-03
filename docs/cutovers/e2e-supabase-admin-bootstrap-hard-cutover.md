# E2E Supabase Admin Bootstrap Hard Cutover

## Status

Implemented cutover spec. This document owns the production-ready plan
for Playwright E2E Supabase Auth bootstrap, test-user seeding, and local
Supabase env resolution.

The implementation is a hard cutover. There is no legacy mode, compatibility
alias, silent fallback, mock-auth lane, app-runtime service-role leak, or
dashboard-only checklist. Missing Supabase admin configuration is an E2E
bootstrap failure, not a spec failure and not a reason to weaken the product
runtime.

## External References

- Playwright global setup and teardown:
  https://playwright.dev/docs/test-global-setup-teardown
- Playwright authentication setup projects and `storageState`:
  https://playwright.dev/docs/auth
- Supabase JavaScript Auth Admin API:
  https://supabase.com/docs/reference/javascript/admin-api
- Supabase API keys:
  https://supabase.com/docs/guides/getting-started/api-keys

Facts these references establish:

- Playwright setup work should be explicit, repeatable, and visible enough for
  failures to diagnose before real specs run.
- Playwright supports a setup project that authenticates once and saves
  `storageState`; this repo already uses that shape for `auth.setup.ts`.
- Supabase Auth admin operations require a secret/admin credential and belong on
  a trusted server or trusted test bootstrap process.
- Secret/service-role credentials must never be exposed to browser code.

## Problem Statement

Full Playwright execution can be blocked before specs run when global setup
cannot seed the E2E Supabase Auth user. The visible failure is:

```text
Missing Supabase admin configuration. Expected live values from `supabase status`
or SUPABASE_URL plus command-scoped SUPABASE_AUTH_ADMIN_KEY.
```

That failure is correct in spirit: E2E auth bootstrap needs Supabase admin
privilege. The defect is the ownership and contract around that privilege:

- `e2e/supabase-env.cjs` has partial env/status resolution.
- `python/scripts/supabase_auth_config.py` has a second env/status resolver.
- `scripts/test_env.sh` has a third Supabase status parser for shell wrappers.
- `scripts/test_env.sh` clears `SUPABASE_AUTH_ADMIN_KEY` for generic test
  commands.
- `global-setup.mjs`, `seed-e2e-user.ts`, and `auth-bootstrap.ts` discover
  missing admin config at different points.
- CI starts Supabase directly and then calls a Make target that also owns
  Supabase startup.

The professional fix is to make Supabase admin bootstrap a first-class E2E
capability with one contract, one resolver, one failure shape, and hard runtime
separation from application processes.

## Governing Repo Rules

This cutover is governed by:

- `docs/rules/testing_standards.md`: E2E runs against real services:
  production-built Next.js, non-reload FastAPI, PostgreSQL, and Supabase local.
  No mock API servers, no MSW, and no browser-test SQL shortcuts.
- `docs/rules/testing_standards.md`: E2E seed data uses app APIs or dedicated
  `e2e/` seed scripts, deterministic inputs, idempotent setup, and centralized
  Playwright setup guarantees shared by Make, direct Playwright, and CI.
- `docs/rules/environment.md`: every source-read env var appears in
  `.env.example`, with required/optional/default semantics.
- `docs/rules/layers.md`: OAuth/Auth stays server-side; no browser Supabase
  client and no browser-held tokens.
- `docs/rules/entrypoints.md`: side effects belong in explicit bootstrap
  locations.
- `docs/rules/correctness.md`: validate at ingress; fail loudly instead of
  silently normalizing impossible states.
- `docs/rules/cleanliness.md`: one concern, one owner; remove duplicate
  validators, normalizers, and compatibility branches.
- `docs/rules/tech-stack.md`: Supabase is Auth only; standalone Postgres and
  R2/MinIO are product data/storage.

## Scope

In scope:

- Local Supabase Auth env resolution for test/bootstrap commands.
- Playwright E2E global setup and setup-project authentication.
- E2E seed scripts that need a Supabase Auth admin credential.
- Makefile wrapper ordering for `test-e2e`, `test-csp`, `test-real-media`,
  `seed-real-media-e2e`, and `test-supabase` if it uses the shared Supabase
  wrapper.
- CI workflow E2E startup ownership.
- Direct Playwright invocation from `e2e/` when local Supabase is already
  running.
- Tests for resolver precedence, missing config, redaction, local-only checks,
  and runtime secret scrubbing.
- Documentation updates for `.env.example`, `README.md`, `apps/web/README.md`,
  `docs/rules/testing_standards.md`, and `docs/architecture.md` where the
  contract changes.

Out of scope:

- Replacing Supabase Auth.
- Moving auth to the product database.
- Changing FastAPI JWT/JWKS verification.
- Adding browser Supabase clients.
- Adding product test-only routes.
- Running Playwright against hosted production Supabase Auth.
- Mutating hosted Supabase dashboard/Auth config.
- Reworking all E2E seed data. Only bootstrap env ownership and directly
  affected seed entrypoints are in scope.

## Goals

- Make missing Supabase admin config fail before any seed command starts.
- Keep Supabase admin credentials command-scoped to trusted bootstrap processes.
- Ensure Next.js, FastAPI, worker, and helper subprocess app runtimes never
  inherit Supabase admin/database/service-role env.
- Remove duplicate Supabase status parsing and env derivation.
- Remove legacy admin env aliases from accepted bootstrap inputs.
- Preserve real-stack E2E behavior: real Supabase local Auth, real Postgres,
  real MinIO/R2-compatible storage, production-built Next.js, non-reload
  FastAPI.
- Keep direct Playwright, Make, and CI on one setup contract.
- Make diagnostics actionable and redacted.
- Add tests below full Playwright so the resolver cannot regress only at
  global setup time.

## Non-Goals

- Do not put `SUPABASE_AUTH_ADMIN_KEY`, `SUPABASE_SERVICE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SERVICE_ROLE_KEY`, or `SUPABASE_DATABASE_URL`
  in Vercel, Hetzner, Next.js, FastAPI, worker, or browser runtime env.
- Do not teach app runtime `Settings` to tolerate Supabase admin keys.
- Do not read admin credentials from `.env`, `.dev-ports`, Vercel env files, or
  production deploy env files.
- Do not accept `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or
  `SERVICE_ROLE_KEY` as bootstrap aliases. They remain forbidden runtime names,
  not accepted compatibility inputs.
- Do not continue if auth bootstrap cannot create/list the E2E user.
- Do not fall back to anonymous auth, public anon keys, fake JWTs, mocked
  Supabase responses, or locally generated sessions.
- Do not leave both old and new status parsers alive.
- Do not rely on a manually run `supabase start` step in CI before Make.
- Do not introduce a new long-lived secret file for E2E.
- Do not add broad "remote Supabase E2E" support. E2E is local-Supabase only.

## Current Owners To Reuse

- `e2e/global-setup.mjs` owns centralized pre-test E2E setup and seed ordering.
- `e2e/tests/auth.setup.ts` owns the Playwright setup project that writes
  `.auth/user.json`.
- `e2e/tests/auth-bootstrap.ts` owns the real magic-link session bootstrap.
- `e2e/seed-e2e-user.ts` owns the Supabase Auth user record.
- `python/scripts/seed_e2e_data.py` owns Nexus DB/default-library/media corpus
  fixture seeding after the auth user exists.
- `python/scripts/seed_oracle_plate_e2e.py` owns Oracle owned-plate fixture
  seeding.
- `scripts/with_supabase_services.sh` owns local Supabase process lifecycle for
  test commands.
- `scripts/with_test_services.sh` owns local Postgres, MinIO, and app port
  allocation.
- `python/nexus/config.py` owns backend runtime env validation and already
  rejects Supabase admin/database env.
- `deploy/vercel/sync-env.sh` and `deploy/hetzner/sync-env.sh` own production
  runtime env admission and already reject Supabase admin/database env.
- `.env.example`, `deploy/env/README.md`, `deployment.md`, and
  `docs/architecture.md` own operator-facing env contracts.

## Duplicate Patterns To Consolidate

### Supabase Status Parsing

Current repeated patterns:

- `e2e/supabase-env.cjs` parses `supabase status --output json`.
- `python/scripts/supabase_auth_config.py` parses the same CLI output.
- `scripts/test_env.sh` parses the same CLI output with shell `grep`/`sed`.
- `Makefile` local `dev` also parses status for `.dev-ports`.

Final state:

- E2E/test bootstrap status parsing has one owner: `e2e/supabase-env.cjs`.
- Shell test wrappers call that owner in CLI mode instead of parsing status.
- Playwright configs and global setup import that owner directly.
- Python seed scripts do not call `supabase status`; they require the canonical
  command-scoped env prepared by the E2E bootstrap owner.
- `make dev` may keep its local `.dev-ports` public-env extraction if it remains
  scoped to local interactive dev and does not own E2E admin bootstrap.

### Admin Env Resolution

Current repeated patterns:

- `seed-e2e-user.ts` asks for admin env independently.
- `auth-bootstrap.ts` asks for admin env independently.
- Python seed scripts ask `supabase_auth_config.py` independently.

Final state:

- One required-admin resolver validates and applies:
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ISSUER`,
  `SUPABASE_JWKS_URL`, `SUPABASE_AUDIENCES`, and
  `SUPABASE_AUTH_ADMIN_KEY`.
- Callers do not hand-roll "missing Supabase admin" checks.
- Callers may assert that the resolved object has the specific fields they need,
  but the diagnostic belongs to the resolver.

### App Runtime Secret Scrubbing

Current repeated patterns:

- Base and CSP Playwright configs delete admin/service-role aliases.
- Real-media helper subprocesses delete the same aliases.
- Conversation-tree seed helper deletes the same aliases.
- Python seed scripts capture the admin key, then delete the same aliases before
  loading app settings/storage code.

Final state:

- A single shared E2E helper owns "app runtime env" creation for Playwright web
  servers and child worker-like subprocesses:

  ```js
  export function buildE2eAppRuntimeEnv(sourceEnv = process.env): NodeJS.ProcessEnv;
  ```

- It deletes:
  `SUPABASE_AUTH_ADMIN_KEY`, `SUPABASE_DATABASE_URL`,
  `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `SERVICE_ROLE_KEY`.
- Python seed scripts keep their capture-then-pop step because they run in a
  separate language and are their own process boundary, but the list of forbidden
  names must match the JS helper and backend Settings test.

### Playwright Config Preamble

Current repeated patterns:

- `e2e/playwright.config.ts` and `e2e/playwright.csp.config.ts` both load root
  env, resolve Supabase env, set encryption/rate-limit defaults, derive ports,
  and build app runtime env.

Final state:

- Shared E2E config helper:

  ```js
  export function preparePlaywrightProcessEnv(options: {
    requireAdmin: boolean;
    cspMode: "disabled" | "enforced";
    realMedia: boolean;
  }): PreparedPlaywrightEnv;
  ```

- Base and CSP configs import the helper; they do not duplicate env preambles.
- The helper must not add a generic framework abstraction. It is E2E config
  plumbing only.

## Target Behavior

### Make-Driven Default E2E

`make test-e2e`:

1. Installs/ensures E2E deps.
2. Starts isolated Postgres and MinIO via `with_test_services.sh`.
3. Starts local Supabase Auth via `with_supabase_services.sh`.
4. Resolves Supabase public and admin bootstrap env with the canonical resolver.
5. Runs Playwright with `NEXUS_ENV=test`, `E2E_REAL_MEDIA=0`,
   `SUPABASE_AUTH_ADMIN_KEY` available to Playwright setup only, and local
   database/storage/app ports.
6. Playwright global setup validates all required local E2E env before running
   any seed command.
7. Web/API server env is scrubbed before process launch.
8. Setup project creates real Supabase session state through real Supabase Auth.
9. Specs run with `storageState`.

If Supabase admin env cannot be resolved, the command fails before migrations,
seed scripts, Next build, FastAPI startup, or specs.

### Make-Driven CSP E2E

`make test-csp` uses the same Supabase bootstrap contract as default E2E.

Differences:

- Next.js runtime has `E2E_DISABLE_CSP=0`.
- Playwright uses `playwright.csp.config.ts`.
- Auth state is written to `.auth/user-csp.json`.

There is no separate CSP admin-env path.

### Direct Playwright Invocation

From `e2e/`, direct invocation remains supported only when the local stack is
already running:

```bash
bun run test:e2e -- tests/password-auth.spec.ts --project=chromium
```

Global setup calls the same required resolver. It may read live local
`supabase status` through `e2e/supabase-env.cjs`; this is not a fallback path,
it is the canonical direct-run source. If local Supabase is not running or does
not expose the required fields, direct Playwright fails with the same preflight
diagnostic and points the operator to `make test-e2e`.

Direct invocation does not read admin credentials from `.env`.

### CI E2E

CI installs the Supabase CLI, then delegates lifecycle to Make. It does not run a
separate `supabase start` step for default E2E or CSP E2E.

Final CI shape:

```yaml
- uses: supabase/setup-cli@...
  with:
    version: 2.90.0

- name: Test E2E shard
  run: make test-e2e PLAYWRIGHT_ARGS="--shard=${{ matrix.shard }}/2"
```

`make test-e2e` is the single source of truth for Supabase startup, status
resolution, and teardown.

### Python Seed Scripts

Python seed scripts are trusted E2E bootstrap commands. They receive:

- `SUPABASE_URL`
- `SUPABASE_AUTH_ADMIN_KEY`
- `DATABASE_URL`
- R2/MinIO env
- `NEXUS_ENV=local|test`

They do not call `supabase status`.

They immediately capture the admin credential into local variables, remove all
admin/database/service-role aliases from `os.environ`, then import app settings
or storage code. If env is missing, they fail with the same canonical message.

### Local-Only Safety

Default and CSP E2E are local only:

- `SUPABASE_URL` must be `http://localhost:*` or `http://127.0.0.1:*`.
- `DATABASE_URL` must point at localhost/127.0.0.1/loopback.
- `R2_S3_API_ORIGIN` must point at localhost/127.0.0.1/loopback.
- `NEXUS_ENV` must be `test` for default/CSP and `local` for real-media.

Hosted Supabase Auth is covered by deploy verification and smoke checks, not by
local Playwright E2E.

## Final Architecture

### Bootstrap Topology

```text
make test-e2e
  |
  v
scripts/with_test_services.sh
  - owns Postgres, MinIO, API/Web port allocation
  |
  v
scripts/with_supabase_services.sh
  - owns local Supabase lifecycle
  - calls e2e/supabase-env.cjs --shell --require-admin
  - exports canonical Supabase public/admin bootstrap env
  |
  v
e2e/playwright.config.ts
  - imports shared E2E config helper
  - validates process env
  - builds scrubbed app runtime env
  |
  v
e2e/global-setup.mjs
  - runs required preflight
  - seeds Supabase Auth user
  - runs migrations
  - runs product seed scripts
  |
  v
e2e/tests/auth.setup.ts
  - uses real Supabase admin generate_link
  - writes storageState
  |
  v
specs
```

### Trust Boundaries

Trusted bootstrap processes:

- `scripts/with_supabase_services.sh`
- `e2e/global-setup.mjs`
- `e2e/seed-e2e-user.ts`
- `e2e/tests/auth-bootstrap.ts`
- `python/scripts/seed_e2e_data.py`
- `python/scripts/seed_oracle_plate_e2e.py`
- real-media seed scripts that explicitly run as E2E bootstrap

Untrusted or app-runtime processes:

- Next.js web server
- FastAPI API server
- worker process
- browser contexts
- BFF route handlers
- frontend client bundle
- product subprocesses spawned to simulate worker behavior

Only trusted bootstrap processes may see `SUPABASE_AUTH_ADMIN_KEY`.

### Source Of Truth

`e2e/supabase-env.cjs` owns E2E Supabase env:

- parsing local Supabase CLI status
- validating local-only URL shape
- validating complete explicit command env
- applying public Supabase env
- applying required admin env
- printing shell exports for wrappers
- redacting diagnostics

`python/scripts/supabase_auth_config.py` becomes a strict Python adapter over
already-prepared env. It no longer owns CLI status parsing.

## Capability Contracts

### `e2e/supabase-env.cjs`

Capability: resolve, validate, apply, and print E2E Supabase Auth env.

Public API:

```js
export class SupabaseE2EEnvError extends Error {}

export function parseSupabaseStatus(rawStatus);

export function resolveSupabaseE2EEnv(rootDir, env, options);

export function applySupabasePublicEnv(rootDir, env, options);

export function requireSupabaseAdminEnv(rootDir, env, options);

export function buildE2eAppRuntimeEnv(sourceEnv);

export function redactSupabaseE2EEnvForError(resolved);
```

Types:

```ts
interface SupabaseE2EEnv {
  readonly source: "local-cli-status" | "explicit-command-env";
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly adminKey?: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audiences: "authenticated";
}

interface ResolveOptions {
  readonly requireAdmin: boolean;
  readonly allowFilePublicEnv: boolean;
  readonly allowExplicitCommandEnv: boolean;
}
```

Rules:

- `requireAdmin: true` returns an object with `adminKey` or throws.
- Accepted admin sources:
  - local `supabase status --output json` `SECRET_KEY`
  - explicit command-scoped `SUPABASE_AUTH_ADMIN_KEY`, only when paired with
    complete explicit public env.
- Accepted public sources:
  - local `supabase status --output json` `API_URL` and `ANON_KEY`
  - local `supabase status --output json` `API_URL` and `PUBLISHABLE_KEY`
  - explicit command-scoped `SUPABASE_URL` and `SUPABASE_ANON_KEY`
  - explicit command-scoped `NEXT_PUBLIC_SUPABASE_URL` and
    `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - file public env from `.env`/`.dev-ports` only when admin is not being read
    from that file and the local-only check passes.
- Rejected admin sources:
  - `.env`
  - `.dev-ports`
  - `SUPABASE_SERVICE_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SERVICE_ROLE_KEY`
  - `SUPABASE_DATABASE_URL`
  - default hardcoded service-role values
- If local Supabase status emits only `SERVICE_ROLE_KEY` and not `SECRET_KEY`,
  update/pin the Supabase CLI or make an explicit one-time decision during this
  cutover. Do not keep both status schemas accepted indefinitely.
- Error messages name missing fields and accepted sources.
- Error messages never print admin key values, anon key values, database URLs
  with passwords, or raw status output.

CLI mode:

```bash
node e2e/supabase-env.cjs --print-shell --require-admin
```

Output:

```sh
export SUPABASE_URL='http://127.0.0.1:54321'
export SUPABASE_ANON_KEY='...'
export NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321'
export NEXT_PUBLIC_SUPABASE_ANON_KEY='...'
export SUPABASE_ISSUER='http://127.0.0.1:54321/auth/v1'
export SUPABASE_JWKS_URL='http://127.0.0.1:54321/auth/v1/.well-known/jwks.json'
export SUPABASE_AUDIENCES='authenticated'
export SUPABASE_AUTH_ADMIN_KEY='...'
```

Shell output must be quoted safely and must not log a redacted summary to
stdout. Diagnostics go to stderr.

### `python/scripts/supabase_auth_config.py`

Capability: strict Python seed adapter for already-resolved Supabase admin env.

Public API:

```python
class SupabaseAuthConfigError(RuntimeError): ...

def resolve_supabase_auth_config(environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    ...

def load_supabase_auth_config() -> tuple[str, str]:
    ...

def load_supabase_auth_config_or_exit() -> tuple[str, str]:
    ...
```

Rules:

- Require `SUPABASE_URL`.
- Require `SUPABASE_AUTH_ADMIN_KEY`.
- Reject `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `SERVICE_ROLE_KEY` when they are non-empty, with a message that they are not
  accepted bootstrap aliases.
- Do not call `supabase status`.
- Do not default `SUPABASE_URL` to `http://127.0.0.1:54321`.
- Do not read `.env`.
- Do not print secrets.

### `scripts/with_supabase_services.sh`

Capability: local Supabase lifecycle and shell env export for test commands.

Rules:

- Starts the local Supabase stack.
- Waits for core containers to be healthy.
- Calls `node e2e/supabase-env.cjs --print-shell --require-admin` when the
  downstream command declares it needs E2E admin bootstrap.
- Exports only canonical names.
- Does not parse status with `grep`/`sed`.
- Does not export legacy service-role aliases.
- Cleans up the Supabase stack unless `SUPABASE_KEEP_RUNNING=1`.
- Does not run app tests itself; it is a lifecycle/env wrapper.

Admin-requiring commands:

- `test-e2e`
- `test-csp`
- `test-real-media`
- `seed-real-media-e2e`

Admin-optional commands:

- `test-supabase`, only if those tests do not call Supabase Admin. If they do,
  they must opt into the same required-admin contract instead of rediscovering
  status.

### `scripts/with_test_services.sh`

Capability: local Postgres/MinIO/app-port lifecycle.

Rules:

- It must not destroy an already-resolved E2E admin bootstrap env when it wraps
  an admin-requiring command.
- Prefer wrapper ordering where `with_test_services.sh` is outermost and
  `with_supabase_services.sh` is innermost for E2E, so generic app-port setup
  cannot erase Supabase admin env after it is resolved.
- Generic runtime env cleanup remains valid for app processes, but app-runtime
  scrubbing is owned by the Playwright/shared helper.

### Playwright Config Helpers

Capability: prepare per-run Playwright process env and app server env.

Rules:

- Base config and CSP config import shared helpers.
- `globalSetup` runs before server launch and fails if required env is missing.
- Web/API server env is built through `buildE2eAppRuntimeEnv`.
- `reuseExistingServer` remains false.
- `workers: 1` remains for default E2E while the suite shares one authenticated
  seed user and mutates user-scoped state.
- CSP config must not silently drift from base config.

## API And Env Design

Canonical bootstrap env:

```text
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<local-anon-or-publishable-key>
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local-anon-or-publishable-key>
SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
SUPABASE_AUDIENCES=authenticated
SUPABASE_AUTH_ADMIN_KEY=<command-scoped-local-secret-key>
```

Env semantics:

- `SUPABASE_URL`: local Supabase API URL used by trusted bootstrap scripts and
  by public auth clients in local E2E.
- `SUPABASE_ANON_KEY`: local Supabase public anon/publishable key.
- `NEXT_PUBLIC_SUPABASE_*`: public values used by Next.js and browser-side
  Supabase SSR/session helpers.
- `SUPABASE_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_AUDIENCES`: FastAPI JWT
  verification values.
- `SUPABASE_AUTH_ADMIN_KEY`: trusted bootstrap-only Supabase Auth admin
  credential. It is command-scoped and must be removed from app-runtime env.

Do not add:

- `E2E_SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SERVICE_KEY` as accepted input
- `SUPABASE_SERVICE_ROLE_KEY` as accepted input
- `SERVICE_ROLE_KEY` as accepted input
- `SUPABASE_DATABASE_URL` for app data
- `E2E_SKIP_AUTH_SEED`
- `E2E_USE_FAKE_AUTH`
- `E2E_ALLOW_REMOTE_SUPABASE_AUTH`

If a future need for remote Supabase Auth E2E appears, it requires a separate
spec with threat model, data lifecycle, credential rotation, and CI isolation.

## File Plan

### Modified Files

`e2e/supabase-env.cjs`

- Replace permissive partial resolver with explicit public/admin resolver.
- Add required-admin API.
- Add local-only validation.
- Add redacted diagnostics.
- Add CLI shell-export mode.
- Delete accepted legacy admin env aliases.

`e2e/global-setup.mjs`

- Run required Supabase preflight before `run("Seed E2E user", ...)`.
- Reuse resolved env for seed subprocesses.
- Add regular-E2E local DB and R2/MinIO checks equivalent to the real-media
  safety posture.
- Remove indirect "seed script will discover admin" behavior.

`e2e/seed-e2e-user.ts`

- Call the required-admin helper, not a local hand-rolled missing-env check.
- Keep idempotent create/list behavior.
- Keep writing `.seed/e2e-user.json`.

`e2e/tests/auth-bootstrap.ts`

- Call the required-admin helper, not a local hand-rolled missing-env check.
- Keep real `generate_link` flow.
- Keep session cookie/storageState behavior.

`e2e/playwright.config.ts`

- Use shared config/env helper.
- Keep `workers: 1`, setup project, and app runtime scrubbing.

`e2e/playwright.csp.config.ts`

- Use the same shared config/env helper.
- Keep only CSP-specific differences.

`e2e/tests/conversation-tree-seed.ts`

- Use shared app-runtime env scrubber for Python child process.

`e2e/tests/real-media/real-media-seed.ts`

- Use shared app-runtime env scrubber for worker-like child process.

`python/scripts/supabase_auth_config.py`

- Remove CLI status parsing.
- Remove default URL fallback.
- Require canonical env.
- Reject legacy aliases as inputs.

`python/scripts/seed_e2e_data.py`

- Keep NEXUS_ENV guard.
- Capture strict `SUPABASE_AUTH_ADMIN_KEY`, then pop forbidden keys before app
  settings/storage imports.
- Rely on shared Python helper for canonical error text.

`python/scripts/seed_oracle_plate_e2e.py`

- Same as `seed_e2e_data.py`.

`scripts/test_env.sh`

- Remove Supabase status `grep`/`sed` parsing for E2E admin/public env.
- If public-only Supabase env is still needed for non-E2E tests, delegate to the
  same resolver in public-only mode.
- Keep Postgres/MinIO/app-port ownership.

`scripts/with_supabase_services.sh`

- Delegate env export to the canonical resolver CLI.
- Accept a clear admin-required mode for E2E.
- Do not export legacy aliases.

`Makefile`

- Make wrapper ordering explicit and consistent.
- Remove CI/manual assumptions from local targets.
- Ensure admin-requiring E2E targets opt into required Supabase admin bootstrap.
- Keep `api`, `api-e2e`, and `worker` clearing admin env at runtime.

`.github/workflows/ci.yml`

- Remove direct `supabase start` steps from E2E jobs.
- Keep Supabase CLI installation.
- Rely on Make targets for lifecycle and env.

`.env.example`

- Update Supabase local section:
  - command-scoped `SUPABASE_AUTH_ADMIN_KEY`
  - not read from `.env`
  - local resolver reads status for direct Playwright and wrapper commands
  - legacy aliases are forbidden and not accepted.

`README.md`, `apps/web/README.md`, `docs/architecture.md`,
`docs/rules/testing_standards.md`

- Document final E2E bootstrap contract and command ownership.

`deploy/vercel/sync-env.sh`, `deploy/hetzner/sync-env.sh`

- No behavioral change expected unless tests expose missing forbidden-key
  coverage.

### New Files

`e2e/setup-env.mjs` or `e2e/playwright-env.mjs`

- Shared Playwright env helper if keeping it separate from `supabase-env.cjs`
  improves ownership.
- Do not create both if one module is enough.

`e2e/supabase-env.test.mjs`

- Node built-in test coverage for parser/resolver/CLI output.

`python/tests/test_supabase_auth_config.py`

- Already exists; update expectations for strict env-only behavior.

`python/tests/test_e2e_supabase_env_cli.py` or equivalent

- Optional subprocess tests for `node e2e/supabase-env.cjs --print-shell`.
- Use only if JS-side tests cannot cover CLI shell escaping adequately.

### Deleted Or Final-State Forbidden Code

Delete:

- Python `supabase status` subprocess parsing in
  `python/scripts/supabase_auth_config.py`.
- Shell `grep`/`sed` Supabase admin/public parsing in `scripts/test_env.sh` for
  E2E paths.
- Local missing-admin checks in `seed-e2e-user.ts` and `auth-bootstrap.ts` once
  replaced by the shared helper.
- Duplicate Playwright env preambles in base/CSP config.

Forbidden:

- Any new accepted env alias for admin keys.
- Any runtime Settings field that stores an admin/service-role key.
- Any test-only route that creates sessions.
- Any `E2E_SKIP_*` bypass for auth seeding.

## Implementation Sequence

### Phase 0: Lock The Contract With Tests

Add failing tests before changing behavior:

1. JS resolver rejects missing admin when `requireAdmin=true`.
2. JS resolver accepts complete local CLI status with `API_URL`, public key, and
   `SECRET_KEY`.
3. JS resolver rejects CLI status without `SECRET_KEY`.
4. JS resolver accepts complete explicit command env.
5. JS resolver rejects partial explicit command env.
6. JS resolver rejects non-local `SUPABASE_URL`.
7. JS resolver rejects legacy admin aliases.
8. JS resolver redacts keys in error output.
9. JS app-runtime env scrubber removes all forbidden keys and preserves public
   auth/env values.
10. Python helper requires strict env and no longer calls `supabase status`.

Do not start by patching global setup. First prove the new owner-level contract.

### Phase 1: Implement Canonical Resolver

Refactor `e2e/supabase-env.cjs`:

- Split parsing from resolution.
- Model source as a small discriminated value.
- Add required-admin mode.
- Add local-only validation.
- Add shell export mode.
- Add redaction helper.
- Delete legacy alias acceptance.

Keep the API small. Do not add options for remote E2E, compatibility aliases, or
partial mixed sources.

### Phase 2: Cut Python To Env-Only

Update `python/scripts/supabase_auth_config.py`:

- Remove `json`, `subprocess`, and status parsing.
- Remove default local URL.
- Require `SUPABASE_URL` and `SUPABASE_AUTH_ADMIN_KEY`.
- Reject legacy aliases.
- Update tests.

Then update Python seed scripts only as needed to use the strict helper.

### Phase 3: Cut Playwright Bootstrap To Required Preflight

Update `global-setup.mjs`:

- Load `.env`/`.dev-ports` for public/runtime parity only.
- Run required Supabase preflight.
- Run local DB and R2/MinIO checks.
- Pass the resolved canonical env to seed subprocesses.
- Fail before seed commands when preflight fails.

Update `seed-e2e-user.ts` and `auth-bootstrap.ts` to call the shared helper and
remove local missing-env messages.

### Phase 4: Cut Wrapper Ownership

Update shell wrappers and Make:

- Make E2E targets run `with_test_services.sh` outermost and
  `with_supabase_services.sh` innermost, or otherwise prove
  `with_test_services.sh` cannot erase resolved admin env after Supabase export.
- Make `with_supabase_services.sh` call the resolver CLI.
- Remove duplicate shell status parsing.
- Keep teardown and lock behavior.
- Ensure non-admin Supabase tests either stay public-only or opt into
  required-admin mode explicitly.

### Phase 5: Cut CI To Make-Owned Supabase

Update CI:

- Remove direct `supabase start` steps from default E2E and CSP jobs.
- Keep Supabase CLI install.
- Run Make targets only.
- Keep artifacts upload unchanged.

### Phase 6: Consolidate Playwright Config Preamble

Create or update shared helper:

- Prepare process env for base/CSP configs.
- Build scrubbed app runtime env.
- Keep CSP differences explicit.
- Keep real-media differences explicit.

### Phase 7: Documentation And Cleanup

Update:

- `.env.example`
- `README.md`
- `apps/web/README.md`
- `docs/architecture.md`
- `docs/rules/testing_standards.md`

Then search for forbidden concepts:

```bash
rg -n "SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|supabase status|Missing Supabase admin|E2E_SKIP_AUTH|E2E_USE_FAKE_AUTH" e2e python scripts Makefile .github docs .env.example
```

Every remaining hit must be either:

- forbidden-runtime-key rejection,
- deployment cleanup/legacy operator documentation unrelated to E2E bootstrap,
- test asserting rejection,
- or the canonical resolver's status call.

## Acceptance Criteria

### Behavior

- `make test-e2e` starts local Supabase through the repo wrapper and reaches
  Playwright setup with a resolved command-scoped admin key.
- `make test-csp` uses the same bootstrap contract.
- Direct `cd e2e && bun run test:e2e -- ...` either uses running local Supabase
  through the same resolver or fails before seed commands with the canonical
  diagnostic.
- If Supabase local does not expose required admin config, failure occurs before:
  migrations, product seed scripts, Next build, FastAPI startup, setup project,
  or specs.
- `seed-e2e-user.ts` creates or finds the E2E Auth user idempotently.
- `auth-bootstrap.ts` creates a real magic-link session and writes storageState.
- Python seed scripts receive admin env only as trusted bootstrap inputs and pop
  it before app Settings/storage code loads.
- Next.js, FastAPI, and worker runtimes never see `SUPABASE_AUTH_ADMIN_KEY`.
- Hosted Supabase Auth is not used by local Playwright E2E.

### Architecture

- E2E Supabase status parsing has one owner.
- E2E admin env diagnostics have one owner.
- Python no longer shells out to Supabase CLI for admin config.
- Shell wrappers do not parse Supabase status manually for E2E.
- Base and CSP Playwright configs share env preamble logic.
- Legacy admin aliases are not accepted inputs.
- Production env rejection remains in runtime/deploy owners.

### Tests

- JS resolver tests cover success, missing admin, partial env, local-only checks,
  legacy alias rejection, redaction, and shell output.
- Python helper tests cover strict env-only success/failure and legacy alias
  rejection.
- Existing backend Settings tests continue to reject runtime admin keys.
- Vercel/Hetzner env sync tests cover forbidden Supabase admin/service-role
  keys if they do not already.
- Targeted Playwright auth smoke passes locally:

  ```bash
  make test-e2e PLAYWRIGHT_ARGS="tests/password-auth.spec.ts --project=chromium"
  ```

- CSP auth/header smoke passes locally:

  ```bash
  make test-csp PLAYWRIGHT_ARGS="tests/security-headers.csp.spec.ts --project=chromium-csp"
  ```

### Documentation

- `.env.example` states that `SUPABASE_AUTH_ADMIN_KEY` is command-scoped and not
  read from `.env`.
- README docs say `make test-e2e` is the canonical E2E entrypoint and direct
  Playwright requires a running local stack.
- Testing standards mention the required Supabase admin bootstrap contract.
- Architecture docs keep Supabase as Auth only and app data in standalone
  Postgres/R2/MinIO.

## Verification Commands

Targeted verification after implementation:

```bash
node --test e2e/supabase-env.test.mjs
cd python && NEXUS_ENV=test uv run pytest -v --tb=short tests/test_supabase_auth_config.py
cd python && NEXUS_ENV=test uv run pytest -v --tb=short tests/test_config.py::TestSupabaseServiceRoleConfiguration
cd python && uv run pytest -v --tb=short tests/test_vercel_env_sync_validation.py
make check-workflows
make test-e2e PLAYWRIGHT_ARGS="tests/password-auth.spec.ts --project=chromium"
make test-csp PLAYWRIGHT_ARGS="tests/security-headers.csp.spec.ts --project=chromium-csp"
```

Broader follow-up gate when the targeted checks pass:

```bash
make test-e2e
make test-csp
```

Do not use `make verify-full` as the first validation pass for this cutover; it
is too broad for initial failure localization.

## Key Decisions

### D1. Keep Supabase Admin In E2E Bootstrap Only

The admin key is required because Supabase Auth user creation and
`generate_link` are admin operations. It is not product runtime config.

This preserves:

- backend Settings rejection,
- Vercel/Hetzner forbidden-key sync,
- browser no-token/no-Supabase-client rule,
- production Auth-only Supabase posture.

### D2. Use One Resolver, Not Three Parsers

The repeated JS/Python/shell status parsers create drift. The E2E resolver owns
the source of truth because Playwright global setup is the first consumer and
because direct Playwright invocation must share the same behavior.

Python seed scripts become strict consumers of prepared env.

### D3. No Legacy Admin Aliases

`SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SERVICE_ROLE_KEY` stay
as forbidden runtime names only. Accepting them as bootstrap aliases keeps old
semantics alive and makes error messages ambiguous.

The only command-scoped admin env name is `SUPABASE_AUTH_ADMIN_KEY`.

### D4. Local Supabase Only

Local E2E should be hermetic and repeatable. Hosted Supabase Auth has separate
deployment verification and smoke coverage. Remote Auth E2E would introduce
shared mutable identity state, cleanup risk, credential rotation concerns, and
CI isolation requirements.

### D5. Make Owns CI Supabase Lifecycle

CI should run the same command developers run. Starting Supabase in CI before
Make creates two lifecycle owners and hides local/CI drift.

### D6. Direct Playwright Is Supported But Strict

Direct Playwright remains useful for focused iteration. It does not get a
weaker contract: it either resolves the running local Supabase stack through the
same resolver or fails with the same preflight diagnostic.

### D7. Resolver Diagnostics Are Redacted

The resolver may print which source was checked and which field was missing. It
must not print key values or raw status output. The admin key and anon key are
both treated as sensitive in logs.

## Composition With Other Systems

### Next.js Frontend And BFF

Next.js receives public Supabase URL/anon values for auth/session mechanics and
`NEXUS_INTERNAL_SECRET` for BFF-to-FastAPI trust. It never receives
`SUPABASE_AUTH_ADMIN_KEY`.

The cutover does not change `/api/*` proxy behavior, Server Actions, middleware,
CSP policy, or auth callback origin policy.

### FastAPI

FastAPI verifies Supabase-issued JWTs through `SUPABASE_ISSUER`,
`SUPABASE_JWKS_URL`, and `SUPABASE_AUDIENCES`. It never uses a Supabase admin
key at runtime.

The cutover does not change `nexus.auth.verifier`, auth middleware, viewer
injection, or service authorization.

### Worker

Worker-like subprocesses spawned by E2E must receive scrubbed app runtime env.
They may use Postgres/R2/product provider fixture env, but not Supabase admin
env.

### Postgres And Migrations

App data remains in standalone test Postgres. Global setup still applies
migrations before product DB seed scripts. Supabase local may use its own
internal Auth database; product data does not use Supabase Database.

### MinIO / R2-Compatible Storage

E2E fixture storage continues through the same R2-compatible client path backed
by MinIO. The cutover adds regular-E2E local-origin validation matching the
real-media safety posture.

### Real-Media

Real-media keeps `NEXUS_ENV=local` and stricter provider fixture behavior. It
uses the same Supabase Auth admin bootstrap contract, then its existing
real-media-specific checks.

### Deploy Env Sync

Deploy sync remains the production runtime admission gate. This cutover must not
move bootstrap-only admin env into deploy env. Existing forbidden-key behavior
should become more tested, not weaker.

### Supabase Hosted Auth Redirect Verification

Hosted Auth redirect verification remains owned by
`deploy/supabase/verify-auth-redirects.sh`. It uses a management token, not a
service-role/admin auth key, and is read-only. This E2E bootstrap cutover does
not replace it.

## SME Implementation Checklist

- Identify every codepath that reads `SUPABASE_AUTH_ADMIN_KEY`.
- Identify every codepath that parses `supabase status`.
- Decide the exact accepted CLI status schema for local admin key.
- Add resolver tests before changing global setup.
- Remove Python status parsing, do not leave it as a fallback.
- Remove shell status parsing for E2E, do not leave it as a fallback.
- Update wrapper ordering so resolved admin env reaches Playwright setup.
- Confirm app runtime env scrubbing with tests.
- Confirm `make test-supabase` is either public-only or explicitly
  admin-required.
- Remove direct CI `supabase start`.
- Search for legacy aliases and classify each remaining hit.
- Update docs in the same change as behavior.

## Review Questions Before Implementation

1. Which Supabase CLI status field does the pinned CI CLI version expose for the
   local admin credential: `SECRET_KEY` or only `SERVICE_ROLE_KEY`?
2. Does any `python/tests -m supabase` test need admin access, or can
   `test-supabase` stay public/auth-only?
3. Does direct Playwright from `e2e/` need to work after `make dev`, after
   `supabase start`, or only when `make test-e2e` owns the stack?
4. Can `node e2e/supabase-env.cjs --print-shell` be used before `e2e/bun ci`,
   relying only on Node stdlib?
5. Are there existing local workflows that intentionally set
   `SUPABASE_AUTH_ADMIN_KEY` in the shell? If yes, they remain command-scoped,
   but must pass local-only validation.

## Explicitly Rejected Fixes

- Add `SUPABASE_AUTH_ADMIN_KEY` to `.env`.
- Add `SUPABASE_AUTH_ADMIN_KEY` to Vercel env.
- Add `SUPABASE_AUTH_ADMIN_KEY` to Hetzner/VPS env.
- Add `SUPABASE_SERVICE_ROLE_KEY` support as a "temporary" alias.
- Let Python seed scripts call `supabase status` after JS setup fails.
- Let global setup continue and rely on `seed-e2e-user.ts` to fail later.
- Mock Supabase Auth for E2E.
- Generate fake JWT/session cookies without Supabase.
- Skip auth setup when admin config is missing.
- Add a product endpoint to create E2E users.
- Disable backend Settings rejection of admin keys.
- Keep separate base/CSP Playwright env preambles after this cutover.

## Done Definition

This cutover is complete when:

- One E2E Supabase resolver owns status parsing, required admin env, local-only
  validation, shell exports, and redacted diagnostics.
- Python seed scripts consume strict env and no longer parse Supabase CLI status.
- Shell test wrappers no longer parse Supabase status for E2E.
- Make targets and CI use one Supabase lifecycle owner.
- Playwright global setup fails early and clearly on missing admin config.
- App runtimes are proven not to receive admin/service-role env.
- Legacy admin aliases are not accepted anywhere as bootstrap inputs.
- Targeted resolver, Python, env-sync, and Playwright auth/CSP checks pass.
- Docs match the final command and env contract.
- There are no TODOs, compatibility branches, alternate code paths, or stale
  references preserving the old behavior.
