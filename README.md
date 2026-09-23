# Nexus

Nexus is a reading and notes platform with a Next.js frontend, a first-party Android shell, a FastAPI backend, and a Postgres-backed worker.

## Architecture

- Default request path: Browser -> Next.js BFF -> FastAPI -> Postgres.
- Streaming exception: Browser -> FastAPI `/stream/*` endpoints for SSE.
- Background work: worker claims jobs from Postgres (`background_jobs`).
- Local infra: Docker Compose provides dev Postgres plus MinIO for
  R2-compatible object storage; Supabase local provides Auth only.

## Quick Start

### Prerequisites

- Python 3.12+
- Git
- Node.js 22+
- Bun
- Android Studio + Android SDK (only if working in `apps/android/`). The
  Gradle build regenerates the packaged offline reader shelf by running
  `bun run build:offline-reading` in `apps/web`, so Bun and a completed
  `bun install` in `apps/web` are required on any machine that builds the APK.
  Gradle invokes `bun` from its own `PATH`, so launch Android Studio from a
  shell that has Bun on `PATH` (or set it in the IDE's environment).
- Docker (running)
- `uv`
- `actionlint`
- Supabase CLI

### Setup

```bash
make setup
```

### Run Locally

```bash
# terminal 1
make dev

# terminal 2
make api

# terminal 3
make web

# terminals 4 and 5 (optional)
make worker-interactive
make worker-background
```

Open `http://localhost:3000`.

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
- `make setup` generates local `.env` and `apps/web/.env.local`.
- `make dev` writes the live Supabase Auth public URL and anon key to `.dev-ports`.
- static checks are deterministic and unprivileged; they start no services and
  consume no ambient credentials.
- a passing `./scripts/test` establishes static consistency, not working user
  journeys.
- Android builds require `NEXUS_GOOGLE_WEB_CLIENT_ID`; `.env.example` owns the
  contract, and local/CI environment owns the value.

Local application data is stored in the standalone Docker Compose Postgres
container on `localhost:54320`. Local uploads use MinIO through the same
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
a completed `bun install` in `apps/web`: the offline reader shelf is built from
source during the Gradle build rather than committed. Verify App Links and
login before manually creating the `android-v*` GitHub release and attaching
stable and versioned asset names. There is no automated Android release gate.

the release operator owns compatibility between the hosted app and the
published apk. before changing the player protocol or offline reader contract,
compare the latest published apk with the candidate server: player protocol
version and hash, and offline reading protocol, package schema, reader contract,
and reader bundle versions must agree. verify account binding and an offline
shelf-to-online reconnect on the signed apk. publish the compatible apk as part
of the cutover; a backend deployment does not update the apk behind `/android`.

## Repository Map

- `apps/android/` -> Android shell app. Building it runs `bun run build:offline-reading` in `apps/web` to regenerate the git-ignored packaged offline reader shelf. Debug builds default to `http://10.0.2.2:3000`; native auth uses the environment-agnostic `nexus://auth/handoff` flow plus native Google bootstrap. Release APKs require explicit hosted and direct-API origins, version, release keystore, and release certificate fingerprint inputs. `NEXUS_ANDROID_RELEASE_API_ORIGIN` must exactly equal the backend `STREAM_BASE_URL` origin. App links require updating `apps/web/public/.well-known/assetlinks.json` with the release APK signing certificate fingerprint.
- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> browser extension for article, PDF/EPUB, and supported video capture
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
