# Nexus

Nexus is a reading and annotation platform with a Next.js frontend, a FastAPI backend, and a Postgres-backed worker.

## Architecture

- Default request path: Browser -> Next.js BFF -> FastAPI -> Postgres.
- Streaming exception: Browser -> FastAPI `/stream/*` endpoints for SSE.
- Background work: worker claims jobs from Postgres (`background_jobs`).
- Local infra: Supabase local provides Postgres, Auth, Storage, and Studio.

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 22+
- Bun
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
make type-back
make check-workflows
make audit
make test-unit
make test
make verify
make verify-full
make test-e2e
make test-e2e-ui
```

Narrow tiers:

```bash
make test-back-unit
make test-back-integration
make test-front-unit
make test-front-browser
make test-migrations
make test-supabase
make test-network
make test-real
```

## Environment

- `.env.example` is the source of truth for environment variables and defaults.
- `make setup` generates local `.env` and `apps/web/.env.local`.

## Repository Map

- `apps/web/` -> frontend + BFF: see `apps/web/README.md`
- `apps/extension/` -> browser extension for article, PDF/EPUB, and supported video capture
- `python/` -> backend package + tests: see `python/README.md`
- `apps/worker/` -> worker entrypoint: see `apps/worker/README.md`
- `docs/rules/` -> repository rules and boundaries: start at `docs/rules/index.md`
- `docs/sdlc/` -> planning and execution workflow: `docs/sdlc/README.md`
- `docs/reader-implementation.md` -> current reader behavior contract
- `docs/mobile-command-palette.md` -> mobile command launcher behavior contract

## Documentation Rules

Documentation in this repo follows single ownership:

- Put a rule in exactly one owner document.
- Link to owner docs instead of restating them.
- Keep top-level docs short and navigational.

See `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
