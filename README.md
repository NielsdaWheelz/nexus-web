# Nexus

Nexus is a reading and notes platform with a Next.js frontend, a first-party Android shell, a FastAPI backend, and a Postgres-backed worker.

## Architecture

- Default request path: Browser -> Next.js BFF -> FastAPI -> Postgres.
- Streaming exception: Browser -> FastAPI `/stream/*` endpoints for SSE.
- Background work: worker claims jobs from Postgres (`background_jobs`).
- Local infra: Supabase local provides Postgres, Auth, Storage, and Studio.

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

Real-media gates are strict. `make test-real-media` runs deterministic backend
and Playwright acceptance coverage, requires Supabase local plus real OpenAI
embeddings, and seeds the browser corpus through the product paths. `make
test-live-providers` additionally requires real Podcast Index and Deepgram
credentials. The default Playwright project covers deterministic seeded feature
flows; the real-media project covers deterministic real-media acceptance flows.

## Repository Map

- `apps/android/` -> Android shell app. Debug builds default to `http://10.0.2.2:3000`; local OAuth callbacks use the debug-only `nexus-dev://auth/callback` return path. Release APKs require explicit host, version, release keystore, and release certificate fingerprint inputs. App links require updating `apps/web/public/.well-known/assetlinks.json` with the release APK signing certificate fingerprint.
- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> browser extension for article, PDF/EPUB, and supported video capture
- `python/` -> backend package + tests: see `python/README.md`
- `apps/worker/` -> worker entrypoint: see `apps/worker/README.md`
- `docs/rules/` -> repository rules and boundaries: start at `docs/rules/index.md`
- `docs/reader-implementation.md` -> current reader behavior contract
- `docs/reader-protected-width-outward-rail-hard-cutover.md` -> desktop reader protected-width and rail target-state contract
- `docs/chat-unified-components-hard-cutover.md` -> shared chat component spine and reader Ask target-state contract
- `docs/chat-workbench-hard-cutover.md` -> branch-aware full chat workbench target-state contract
- `docs/chat-branch-switch-viewport-hard-cutover.md` -> stable chat branch-switch viewport target-state contract
- `docs/chat-response-retry-hard-cutover.md` -> chat response retry target-state contract
- `docs/real-media-test-target-state.md` -> deterministic real-media test and fixture contract

## Documentation Rules

Documentation placement and rule-shape rules are owned by `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
