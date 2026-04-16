# Nexus Python Backend

Shared Python package for the API server and worker runtime.

## Scope

`python/` owns:

- FastAPI app and route handlers
- Service-layer business logic
- Auth verification and authorization predicates
- Database models and migrations integration
- Background job handlers used by the worker
- Browser extension ingestion services for captured article HTML, browser-fetched PDF/EPUB files, and supported video URLs

## Local Run

From repo root:

```bash
make api
```

Manual run:

```bash
cd apps/api
PYTHONPATH=$PWD/../../python uv run --project ../../python uvicorn main:app --reload --port 8000
```

## API Docs

When running locally:

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Layout

- `nexus/app.py` -> FastAPI app factory
- `nexus/api/routes/` -> HTTP route handlers
- `nexus/services/` -> business logic
- `nexus/auth/` -> auth middleware + permissions + JWT verification
- `nexus/db/` -> SQLAlchemy models and session utilities
- `nexus/jobs/` + `nexus/tasks/` -> job policies and task handlers
- `tests/` -> backend test suite

## Backend Commands

From repo root:

```bash
make check
make test-unit
make test
make verify
make verify-full
make test-back-unit
make test-back-integration
make test-migrations
make test-supabase
make test-network
make test-real
```

## Runtime Contracts

- JWT verification is based on Supabase JWKS.
- Request tracing uses `X-Request-ID` across BFF, API, and worker logs.
- Job kind/retry/lease policy source of truth is `nexus/jobs/registry.py`.
- Captured web articles become `ready_for_reading` in the request path, with `canonical_url` left null for private captures.
- Browser-fetched PDF/EPUB captures reuse the existing upload confirm and document extraction lifecycle.
- Extension URL captures reuse existing URL classification and supported video ingestion.
- Extension auth is scoped and revocable, and it resolves server-side like other authority tokens.

## Environment

Environment variables and defaults are defined in root `.env.example`.
Keep local `.env` in sync via `make setup`.

## Rule Owners

Repository-wide backend rules live in:

- `docs/rules/layers.md`
- `docs/rules/database.md`
- `docs/rules/errors.md`
- `docs/rules/concurrency.md`
