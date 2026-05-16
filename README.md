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

# terminal 4 (optional)
make worker
```

Open `http://localhost:3000`.

## Daily Commands

Use `make help` for the canonical list.

Core:

```bash
make check
make audit
make test-unit
make test
make test-e2e
make test-real-media
make test-live-providers
make verify
make verify-full
```

Focused targets:

```bash
make type-back
make check-workflows
make test-back-unit
make test-back-integration
make test-front-unit
make test-front-browser
make test-migrations
make test-supabase
make verify-android
# Requires Android release signing inputs.
# make verify-android-release
make test-e2e-ui
make seed-real-media-e2e
```

## Environment

- `.env.example` is the source of truth for environment variables and defaults.
- `make setup` generates local `.env` and `apps/web/.env.local`.
- `make dev` writes the live Supabase Auth URL and keys to `.dev-ports`.
- Test wrappers choose free Postgres/MinIO ports unless `TEST_POSTGRES_PORT` or
  `TEST_MINIO_PORT` is set.

Real-media gates are strict. `make test-real-media` runs deterministic backend
and Playwright acceptance coverage, requires Supabase Auth plus local
Postgres/MinIO and real OpenAI embeddings, and seeds the browser corpus through
the product paths. `make test-live-providers` additionally requires real Podcast
Index and Deepgram credentials. The default Playwright project covers
deterministic seeded feature flows; the real-media project covers deterministic
real-media acceptance flows.

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

Create an existing `android-v*` tag, run the Android APK Release workflow for
that tag, install the APK from the draft release on a physical device, verify
App Links and login, then rerun the workflow with `publish_stable=true`. The
workflow uploads stable assets for `/android` plus versioned assets such as
`nexus-android-v0.1.0.apk` for tag `android-v0.1.0`.

## Repository Map

- `apps/android/` -> Android shell app. Debug builds default to `http://10.0.2.2:3000`; local OAuth callbacks use the debug-only `nexus-dev://auth/callback` return path. Release APKs require explicit host, version, release keystore, and release certificate fingerprint inputs. App links require updating `apps/web/public/.well-known/assetlinks.json` with the release APK signing certificate fingerprint.
- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> browser extension for article, PDF/EPUB, and supported video capture
- `python/` -> backend package + tests: see `python/README.md`
- `apps/worker/` -> worker entrypoint: see `apps/worker/README.md`
- `docs/rules/` -> repository rules and boundaries: start at `docs/rules/index.md`
- `docs/reader-implementation.md` -> current reader behavior contract

## Documentation Rules

Documentation placement and rule-shape rules are owned by `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
