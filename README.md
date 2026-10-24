# Nexus

Nexus is a reading and notes platform with a Next.js frontend, a first-party Android shell, a FastAPI backend, and a Postgres-backed worker.

## Architecture

- Default request path: Browser -> Next.js BFF -> FastAPI -> Postgres.
- streaming follows the same browser → next bff → fastapi path.
- Background work: worker claims jobs from Postgres (`background_jobs`).
- Local infra: Docker Compose provides dev postgres plus seaweedfs for
  R2-compatible object storage; Supabase local provides Auth only.

## Quick Start

### Prerequisites

- python 3.12.13
- Git
- Node.js 22+
- Bun
- Android Studio + Android SDK (only if working in `apps/android/`). The
  Gradle build regenerates the packaged shelf (the Downloads screen) by running
  `bun run build:shelf` in `apps/web`, so Bun and a completed
  `bun install` in `apps/web` are required on any machine that builds the APK.
  Gradle invokes `bun` from its own `PATH`, so launch Android Studio from a
  shell that has Bun on `PATH` (or set it in the IDE's environment).
- Docker (running)
- `uv`
- `actionlint`
- `shellcheck`
- supabase cli `2.117.0`

### Setup

```bash
make setup
```

this installs locked dependencies, including the public `universal-memory`
source dependency over https without credentials. configure local overrides in
`.env` using `.env.example`; setup does not generate environment files.

### Run Locally

```bash
# terminal 1
make dev
make migrate

# terminal 2
make api

# terminal 3
make web

# terminal 4: optional linux interactive lane
make worker-interactive

# terminal 5: optional linux background lane
make worker-background
```

open `http://localhost:3000`. `WEB_PORT` selects both the listener and public
origin. `make web` refreshes storage cors for that port before starting next,
including localhost, loopback and android-emulator origins. `make down` stops
services and preserves data.

## disposable verification

use a dedicated checkout/worktree with no root or web dotenv files. install locked
dependencies with `make setup`, then install chromium explicitly:

```sh
cd apps/web
bunx --no-install playwright install chromium
cd ../..
./scripts/lab --help
./scripts/lab -- node apps/web/node_modules/@playwright/test/cli.js test --config apps/web/scripts/lab/playwright.config.ts
```

write temporary cases in `apps/web/.nexus-lab/cases/`. the runtime creates real
database/storage/auth/api/web/workers and one confirmed reader, logs in through
the product, runs the command and tears down only its own resources. the command
receives `NEXUS_LAB_CONTEXT`, an absolute private json path with origins, reader
credentials, browser state and artifact paths. keep application source fixed
while it runs; exit and rerun after edits. one invocation per checkout. no ordinary
web server or static gate concurrently there.

core needs no model credentials. `--live-config FILE` accepts only the documented
provider settings as string/null values; no ambient application configuration
enters core. `provider_endpoint_overrides` is a json-encoded origin map string;
`provider_ca_pem` contains actual pem certificates, added to normal trust roots.
`--live-codex` attaches the dedicated shared host after one-time
`./scripts/lab-codex enroll`. it starts a compatible enrolled stopped host; both
worker lanes stay in linux with separate run/session directories. use
`./scripts/lab-codex status`, `up` and `down` for explicit administration.
ordinary `--live-config` and `--live-codex` may be combined. see the
[host runbook](docs/runbooks/codex-personal-agent-host.md#shared-live-labs).

`--fake-providers` instead starts owned verified https provider wires and real
pinned codex hosts for the host api and linux workers, with fresh synthetic
account state. it cannot combine with either live option. responses use fixed
text over sse/websocket and deterministic 256-dimensional embeddings; this
qualifies transport/composition, not tools, structured output or model quality.
`fake_providers` in the context is normally null, or `{origin, ca_file}` in this
mode; `/health` publishes only fake identity and request counts. see
[provider composition](docs/local-rules/testing-standards.md#provider-composition).

model success is a separate qualification. dependency-hash checkout worker images,
builder caches, the completed web package, its marker, a checkout public auth
key and private diagnostics remain on disk; runs create no per-run images.
clean web source reuses the package at the same sha, slot and public key; each
run gets fresh data and a private writable standalone tree. credentials and sessions are removed
after successful cleanup. caller cases survive until their author deletes them
after red/green/refactor and final qualification.
hard interruption may require exact scoped recovery from the private recovery note.

campaigns use this same runtime in dedicated checkouts and playwright's
`--repeat-each`, with temporary cases and seeds. import `test` from
`apps/web/scripts/lab/test.ts`; its default page and awaited `newPage(context)`
factory prepare each page before app navigation.

`./scripts/lab --client-throttle N -- COMMAND [ARG ...]` accepts an integer
`N >= 1` and reserves both host slots. the context publishes
`client_cpu_throttle: N`, or null ordinarily. the fixture rejects uncontrolled
popups under throttling. default test/expect/action/navigation deadlines scale
with `N`; deliberate choreography pauses do not. see
[client throttling](docs/local-rules/testing-standards.md#client-throttling).

artifacts hold reports, logs, screenshots and history; copied harness
implementations are retired. docker desktop is the sole lab engine (dev-server
`docs/macbook-capacity-plan.md`, d1); d2 fixes the budget at 8 gib and 8 cpus and
requires two concurrent ordinary labs to complete end to end. host cpu burners
and load-average thresholds are retired. calibration and 20-run repeats require
explicit owner approval.

ordinary development remains persistent. this command deliberately creates fresh
stores each time. it uses host api/web toolchains and, without an explicit native
socket, linux container workers. it does not qualify release packaging or other
browser/device platforms.

## Daily Commands

use `make help` for product build/run operations. `./scripts/test` is the sole
automated verification command; it runs static checks only.

```bash
./scripts/test
```

the same fixed check runs on pull requests on the self-hosted devbox. there
is no automated test suite. manually verify affected behavior according to
failure risk and recovery cost; see
[the verification contract](docs/local-rules/testing-standards.md).

Product operations remain Make targets:

```bash
make setup
make dev
make build
make build-android
```

## Environment

- `.env.example` is the source of truth for environment variables and defaults.
- `make setup` installs locked dependencies; configure local environment overrides manually.
- `make dev` writes the live Supabase Auth public URL and anon key to `.dev-ports`.
- static checks are deterministic and unprivileged; they start no services and
  consume no ambient credentials.
- a passing `./scripts/test` establishes static consistency, not working user
  journeys.
- Android builds require `NEXUS_GOOGLE_WEB_CLIENT_ID`; `.env.example` owns the
  contract, and local/CI environment owns the value.

Local application data is stored in the standalone Docker Compose Postgres
container on `localhost:54320`. local uploads use seaweedfs through the same
R2-compatible environment variables used by production storage clients.
Supabase local still starts its own internal database for Auth metadata, but app
tables and object storage do not use Supabase Database or Supabase Storage.

## Android Release Distribution

The private Android companion is distributed from
[`nexus.nielseriknandal.com/android`](https://nexus.nielseriknandal.com/android).
GitHub access to the private release repository is required to download it.

The `/android` page projects GitHub Releases' stable latest-release targets and
does not cache mutable release facts in page copy:

- `https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk`
- `https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk.sha256`
- `https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/release-manifest.json`
- `https://github.com/NielsdaWheelz/nexus-web/releases/latest`

Build the signed APK with `make build-android-release`, record its SHA-256, and
install that exact APK on a physical device. The release machine needs Bun and
a completed `bun install` in `apps/web`: the shelf is built from source during
the Gradle build rather than committed. Verify App Links and
login before manually creating the `android-v*` GitHub release and attaching
stable and versioned asset names. There is no automated Android release gate.

the release operator owns compatibility between the hosted app and the
published apk. neither bridge has a version: the object names `nexusQueueSession`
(player) and `nexusDownloads` (offline) are their identities, and an
incompatible change renames one (the hosted app then shows "Update Nexus for
Android" or "not supported on this device"). verify an offline shelf-to-online reconnect on
the signed apk. publish the compatible apk as part of the cutover; a backend
deployment does not update the apk behind `/android`.

## Repository Map

- `apps/android/` -> Android shell app. Building it runs `bun run build:shelf` in `apps/web` to regenerate the git-ignored packaged shelf (Downloads, see `docs/modules/offline.md`). Debug builds default to `http://10.0.2.2:3000`; native auth uses the environment-agnostic `nexus://auth/handoff` flow plus native Google bootstrap. Release APKs require an explicit hosted origin, version, release keystore, and release certificate fingerprint inputs. App links require updating `apps/web/public/.well-known/assetlinks.json` with the release APK signing certificate fingerprint.
- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> Firefox capture extension (manifest, icons; bundles built into the git-ignored `dist/` by `bun run build:extension` from `apps/web/src/extension/`): saves the current article or a linked PDF/EPUB into chosen libraries. See `docs/modules/ingest.md`.
- `python/` -> backend package: see `python/README.md`
- `apps/worker/` -> worker entrypoint: see `apps/worker/README.md`
- `docs/architecture.md` -> system architecture & orientation guide: start here to learn how everything fits together
- `deployment.md` -> sole production release and recovery runbook
- `docs/rules/` -> repository rules and boundaries: start at `docs/rules/index.md`
- `docs/modules/reader-implementation.md` -> current reader behavior contract
- `docs/modules/reader-design-rationale.md` -> current reader behavior rationale and reader-to-chat quote contract

## Documentation Rules

Documentation placement and rule-shape rules are owned by `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
