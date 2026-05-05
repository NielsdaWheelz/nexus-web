# Nexus

Nexus is a reading and notes platform with a Next.js frontend, a FastAPI backend, and a Postgres-backed worker.

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
make test-e2e-real-media
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
make test-real-media
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
- `docs/feedback-layer-hard-cutover.md` -> unified frontend feedback layer hard-cutover plan
- `docs/evidence-layer-hard-cutover.md` -> unified evidence indexing and citation hard-cutover plan
- `docs/real-media-test-hard-cutover.md` -> real-media evidence test hard-cutover plan
- `docs/notes-layer-hard-cutover.md` -> ProseMirror notes, object links, and annotation hard-cutover plan
- `docs/anchored-projection-hard-cutover.md` -> visible reader highlight projection and secondary-pane hard-cutover plan
- `docs/authors-layer-hard-cutover.md` -> contributor identity and author surface hard-cutover plan
- `docs/reader-implementation.md` -> current reader behavior contract
- `docs/black-forest-oracle-hard-cutover.md` -> hybrid public-domain + library divination feature hard-cutover plan
- `docs/black-forest-oracle-eternal.md` -> current Oracle product contract that supersedes parts of the hard-cutover plan

## Documentation Rules

Documentation in this repo follows single ownership:

- Put a rule in exactly one owner document.
- Link to owner docs instead of restating them.
- Keep top-level docs short and navigational.

See `docs/rules/index.md`.

## License

Proprietary - All rights reserved.
