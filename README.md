# Nexus

A reading and annotation platform.

## Project Structure

```
nexus/
├── apps/                        # Application entrypoints (thin launchers)
│   ├── api/                     # FastAPI server
│   ├── web/                     # Next.js BFF + frontend
│   └── worker/                  # Celery worker
│
├── python/                      # Shared Python package
│   ├── nexus/                   # THE package: models, services, auth, etc.
│   │   ├── config.py            # Pydantic settings
│   │   ├── errors.py            # Error codes
│   │   ├── responses.py         # Response envelopes
│   │   ├── app.py               # FastAPI app creation
│   │   ├── api/                 # HTTP routers
│   │   ├── auth/                # Authentication (JWT verifiers, middleware)
│   │   ├── db/                  # Database layer
│   │   └── services/            # Business logic services
│   ├── tests/                   # Python tests
│   ├── pyproject.toml
│   └── uv.lock
│
├── migrations/                  # Database migrations
│   ├── alembic/
│   │   └── versions/
│   └── alembic.ini
│
├── docker/                      # Docker configs
│   ├── docker-compose.yml       # Local dev services
│   └── Dockerfile.api
│
├── scripts/                     # Development scripts
├── docs/                        # Documentation
├── .env                         # Local config (created by setup, gitignored)
└── Makefile
```

### Architecture Rationale

- **`python/nexus/`** is the single Python package imported by both API and worker
- **`apps/`** contains thin launchers - no code duplication between api/worker
- **`migrations/`** lives at root level, runs against the nexus package
- Tests target `python/nexus` cleanly without starting web apps

## Quick Start

### Prerequisites

- Python 3.12+
- Docker
- [uv](https://github.com/astral-sh/uv) package manager

### Setup

```bash
# Full setup (installs deps, starts services, runs migrations, creates .env)
make setup

# If you have a local postgres on port 5432, use an alternate port:
POSTGRES_PORT=5433 make setup
```

This creates a `.env` file with your configuration that's automatically loaded by subsequent commands.

### Development

```bash
# Start services
make dev

# Run API server
make api

# Run tests (excludes migration tests)
make test

# Run migration tests (separate database)
make test-migrations

# Run all tests
make test-all

# Run linter
make lint

# Format code
make fmt

# Full verification (lint + format check + all tests)
make verify
```

## Configuration

### The `.env` File

Running `make setup` creates a `.env` file with your local configuration:

```bash
# Infrastructure ports
POSTGRES_PORT=5433
REDIS_PORT=6379

# Application config
NEXUS_ENV=local
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5433/nexus_dev
```

This file is:
- **Gitignored** - not committed to the repo
- **Auto-loaded** by Makefile and scripts
- **Created fresh** by each `make setup` run

### Environment Variables

#### Core Settings

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NEXUS_ENV` | No | Environment: `local`, `test`, `staging`, `prod` (default: `local`) |
| `NEXUS_INTERNAL_SECRET` | staging/prod | BFF authentication secret |

#### Infrastructure (for Makefile/Docker)

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PORT` | `5432` | Host port for PostgreSQL container |
| `REDIS_PORT` | `6379` | Host port for Redis container |

#### Auth Settings (Required in staging/prod)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_JWKS_URL` | staging/prod | Full URL to Supabase JWKS endpoint |
| `SUPABASE_ISSUER` | staging/prod | Expected JWT issuer (trailing slash stripped) |
| `SUPABASE_AUDIENCES` | staging/prod | Comma-separated list of allowed audiences |

#### Test Auth Settings (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_TOKEN_ISSUER` | `test-issuer` | Issuer for test JWT tokens |
| `TEST_TOKEN_AUDIENCES` | `test-audience` | Comma-separated test audiences |

### Database URL Format

```
postgresql+psycopg://user:password@host:port/database
```

Example:
```
postgresql+psycopg://postgres:postgres@localhost:5433/nexus_dev
```

## Authentication

Nexus uses JWT bearer token authentication. All endpoints except `/health` require authentication.

### Request Flow

1. Browser authenticates with Supabase via Next.js
2. Next.js extracts the access token from the session
3. Next.js forwards requests to FastAPI with `Authorization: Bearer <token>`
4. FastAPI validates the JWT and derives the user identity

### Internal Header (BFF Gate)

In `staging` and `prod` environments, FastAPI also requires an `X-Nexus-Internal` header:
- Next.js always attaches this header with the configured secret
- This ensures only the BFF can call FastAPI, even with a valid user token

### User Bootstrap

On first authenticated request:
- User row is created in the database
- Default library ("My Library") is created
- Owner admin membership is established

This is race-safe and idempotent.

## API Documentation

When running locally, API docs are available at:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Testing

### Quick Commands

```bash
make test              # Run tests (69 tests, excludes migrations)
make test-migrations   # Run migration tests (11 tests, separate DB)
make test-all          # Run all tests (80 tests)
make verify            # Full verification (lint + format + all tests)
```

### Test Architecture

- **Main tests** run on `nexus_test` database with savepoint isolation (auto-rollback)
- **Migration tests** run on `nexus_test_migrations` database (can drop/recreate schema)
- Tests use `MockTokenVerifier` for JWT validation (local RSA keypair)

### Manual Test Commands

```bash
cd python

# Run specific test files
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5433/nexus_test \
  NEXUS_ENV=test uv run pytest tests/test_auth.py -v

# Run unit tests only (no database required)
DATABASE_URL=postgresql+psycopg://localhost/test \
  uv run pytest tests/test_health.py tests/test_errors.py tests/test_verifier.py -v
```

## Code Quality

```bash
# Lint
make lint

# Format
make fmt

# Or manually:
cd python
uv run ruff check .
uv run ruff format .
```

## Troubleshooting

### Port Conflicts

If you have a local PostgreSQL on port 5432:

```bash
# Use alternate port
POSTGRES_PORT=5433 make setup
```

### Stale Database Connections

If tests hang due to stale connections from killed test runs:

```bash
# Kill idle connections (replace container name if needed)
docker exec <postgres-container> psql -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'nexus_test%' AND state LIKE 'idle%';"
```

### Missing Schema

If tests fail with "relation does not exist":

```bash
make migrate-test  # Apply migrations to test database
```

## License

Proprietary - All rights reserved.
