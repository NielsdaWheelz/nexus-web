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
- Android Studio + Android SDK (only if working in `apps/android/`)
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

Use `make help` for product build/run operations. `./scripts/test` is the sole
test and verification API.

```bash
./scripts/test changed
./scripts/test confidence
./scripts/test pr
./scripts/test full
./scripts/test doctor
```

Scheduled/operator workflows additionally own `nightly` and `release`.
`./scripts/test clean` deletes only ledger-owned local test resources; use
`./scripts/test list --json` for the machine-readable capability registry.

Product operations remain Make targets:

```bash
make setup
make dev
make build
make build-android
make smoke
```

## Environment

- `.env.example` is the source of truth for environment variables and defaults.
- `make setup` generates local `.env` and `apps/web/.env.local`.
- `make dev` writes the live Supabase Auth public URL and anon key to `.dev-ports`.
- The test controller owns one persistent workspace-local
  PostgreSQL/MinIO/Supabase-test stack and records it under `.nexus-test/`.
  Each run gets its own database, bucket, users, and app processes. It rejects
  caller-supplied or production-shaped resource configuration before contact.
- Direct runner commands are debugging tools only. Repository confidence and
  cleanup claims use `./scripts/test`.
- Android builds require `NEXUS_GOOGLE_WEB_CLIENT_ID`; `.env.example` owns the
  contract, and local/CI environment owns the value.

Local application data is stored in the standalone Docker Compose Postgres
container on `localhost:54320`. Local uploads use MinIO through the same
R2-compatible environment variables used by production storage clients.
Supabase local still starts its own internal database for Auth metadata, but app
tables and object storage do not use Supabase Database or Supabase Storage.

## Android Release Distribution

End users install Android from
[`nexus.nielseriknandal.com/android`](https://nexus.nielseriknandal.com/android).

Android self-distribution uses GitHub Releases. The `/android` install page must
link to the stable latest-release assets:

- `https://github.com/<owner>/<repo>/releases/latest/download/nexus-android.apk`
- `https://github.com/<owner>/<repo>/releases/latest/download/nexus-android.apk.sha256`

Create an existing `android-v*` tag, run the Protected release verification workflow for
that tag, install the APK from the draft release on a physical device, verify
App Links and login, then rerun the workflow with `publish_stable=true`. The
workflow uploads stable assets for `/android` plus versioned assets such as
`nexus-android-v0.1.0.apk` for tag `android-v0.1.0`.

## Repository Map

- `apps/android/` -> Android shell app. Debug builds default to `http://10.0.2.2:3000`; native auth uses the environment-agnostic `nexus://auth/handoff` flow plus native Google bootstrap. Release APKs require explicit host, version, release keystore, and release certificate fingerprint inputs. App links require updating `apps/web/public/.well-known/assetlinks.json` with the release APK signing certificate fingerprint.
- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> browser extension for article, PDF/EPUB, and supported video capture
- `python/` -> backend package + tests: see `python/README.md`
- `apps/worker/` -> worker entrypoint: see `apps/worker/README.md`
- `docs/architecture.md` -> system architecture & orientation guide: start here to learn how everything fits together
- `docs/rules/` -> repository rules and boundaries: start at `docs/rules/index.md`
- `docs/modules/reader-implementation.md` -> current reader behavior contract
- `docs/modules/reader-design-rationale.md` -> current reader behavior rationale and reader-to-chat quote contract

## Documentation Rules

Documentation placement and rule-shape rules are owned by `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
