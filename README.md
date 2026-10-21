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

this installs locked dependencies, including the public pinned `universal-memory`
repository over https. configure local overrides in `.env` using `.env.example`;
setup does not generate environment files.

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
provider settings; no ambient application configuration enters core.
`--codex-socket /absolute/existing/app-server.sock` explicitly connects api and a
host interactive worker to an already authenticated native host, qualified through
its ordinary health probe. its host/account remain caller-owned; the runtime
neither copies credentials nor stops that host. the interactive worker's temporary
directory and heartbeat belong to the run. the background worker stays in linux.
model success is a separate qualification. startup, image caches and retained
diagnostics cost local disk and startup time. credentials and sessions are removed
after successful cleanup. caller cases survive until their author deletes them
after red/green/refactor and final qualification.
hard interruption may require exact scoped recovery from the private recovery note.

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
published apk. neither bridge has a version: the object names `nexusPlayer`
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
