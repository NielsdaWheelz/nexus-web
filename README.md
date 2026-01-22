# Nexus

A reading and annotation platform.

## Project Structure

```
nexus/
├── apps/                        # Application entrypoints
│   ├── api/                     # FastAPI server (thin launcher)
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
│   │   ├── db/                  # Database layer + ORM models
│   │   └── services/            # Business logic services
│   ├── tests/                   # Python tests
│   ├── pyproject.toml
│   └── uv.lock
│
├── migrations/                  # Database migrations
│   ├── alembic/
│   │   └── versions/
│   │       ├── 0001_slice0_schema.py     # S0: users, libraries, memberships, media, fragments
│   │       └── 0002_slice1_ingestion_framework.py  # S1: processing lifecycle, storage
│   └── alembic.ini
│
├── docker/                      # Docker configs
│   ├── docker-compose.yml       # Local dev services (postgres 15.8, redis 7.2)
│   └── Dockerfile.api
│
├── .github/workflows/           # CI configuration
│   └── ci.yml                   # GitHub Actions CI pipeline
│
├── scripts/                     # Development scripts
├── docs/                        # Documentation
├── .env.example                 # Environment variable template
├── .env                         # Local config (created by setup, gitignored)
└── Makefile
```

### Architecture

- **BFF Pattern**: Browser → Next.js → FastAPI. Browser never calls FastAPI directly.
- **Single Python Package**: `python/nexus/` is imported by both API and worker.
- **Auth Flow**: Supabase auth → Next.js session cookies → Bearer token to FastAPI.
- **Visibility Enforcement**: All authorization happens in FastAPI, never in Next.js.

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 20+
- Docker
- [uv](https://github.com/astral-sh/uv) package manager

### Setup

```bash
# Full setup (installs deps, starts services, runs migrations, creates .env)
make setup

# If you have a local postgres on port 5432, use an alternate port:
POSTGRES_PORT=5433 make setup

# Install frontend dependencies
cd apps/web && npm install
```

This creates a `.env` file with your configuration that's automatically loaded by subsequent commands.

### Development

```bash
# Start infrastructure services (postgres, redis)
make dev

# In terminal 1: Start API server (http://localhost:8000)
make api

# In terminal 2: Start web frontend (http://localhost:3000)
make web

# In terminal 3 (optional): Start Celery worker
make worker

# Run all tests
make test-all

# Run backend tests only
make test

# Run migration tests (separate database)
make test-migrations

# Run frontend tests only
make test-web

# Seed development data (creates fixture media)
make seed
```

### Run Full Stack

1. Start services: `make dev`
2. Run migrations: `make migrate`
3. Start API: `make api` (terminal 1)
4. Start web: `make web` (terminal 2)
5. Start worker: `make worker` (terminal 3, optional)
6. Open http://localhost:3000

### Infrastructure Commands

```bash
# Start infrastructure (postgres + redis)
make infra-up

# Stop infrastructure
make infra-down

# View infrastructure logs
make infra-logs

# Run a migration rollback
make migrate-down
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

#### Backend (FastAPI)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NEXUS_ENV` | No | Environment: `local`, `test`, `staging`, `prod` (default: `local`) |
| `NEXUS_INTERNAL_SECRET` | staging/prod | BFF authentication secret |
| `SUPABASE_JWKS_URL` | staging/prod | Full URL to Supabase JWKS endpoint |
| `SUPABASE_ISSUER` | staging/prod | Expected JWT issuer |
| `SUPABASE_AUDIENCES` | staging/prod | Comma-separated list of allowed audiences |

#### Celery Worker

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | For worker | Redis connection string (e.g., `redis://localhost:6379/0`) |
| `CELERY_BROKER_URL` | No | Celery broker URL (defaults to `REDIS_URL`) |
| `CELERY_RESULT_BACKEND` | No | Celery result backend URL (defaults to `REDIS_URL`) |

#### Storage (Supabase)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | For storage | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | For storage | Supabase service role key |
| `STORAGE_BUCKET` | No | Storage bucket name (default: `media`) |
| `MAX_PDF_BYTES` | No | Max PDF upload size (default: 100 MB) |
| `MAX_EPUB_BYTES` | No | Max EPUB upload size (default: 50 MB) |
| `STORAGE_TEST_PREFIX` | For tests | Test storage path prefix (e.g., `test_runs/{run_id}/`) |

#### Frontend (Next.js)

| Variable | Required | Description |
|----------|----------|-------------|
| `FASTAPI_BASE_URL` | Yes | FastAPI server URL (e.g., `http://localhost:8000`) |
| `NEXUS_INTERNAL_SECRET` | staging/prod | Same as backend |
| `NEXUS_ENV` | No | Environment (default: `local`) |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |

## Authentication

### Request Flow

1. Browser authenticates with Supabase via Next.js
2. Next.js stores session in cookies (@supabase/ssr)
3. Next.js route handlers:
   - Extract access token from session (server-side only)
   - Forward to FastAPI with `Authorization: Bearer <token>`
   - Attach `X-Nexus-Internal` header
4. FastAPI validates JWT and derives user identity

### Security Model

- **Tokens never in localStorage**: Access tokens exist only in server runtime
- **BFF gate**: In staging/prod, FastAPI rejects requests without internal header
- **Visibility masking**: Unauthorized access returns 404 (not 403) to hide existence

### Request Tracing

Every request receives an `X-Request-ID` header for correlation and debugging:

- **Generation**: If client doesn't provide one, a UUID v4 is generated
- **Propagation**: Browser → Next.js → FastAPI → Celery tasks
- **Logging**: All structured logs (JSON format) include `request_id`
- **Error responses**: Include `request_id` in the body for easy bug reporting

```bash
# Request with custom ID
curl -H "X-Request-ID: my-trace-123" http://localhost:8000/health

# Response includes the ID in header and any error body
```

## API Documentation

When running locally:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Testing

### Commands

```bash
make test              # Backend tests (excludes migrations)
make test-migrations   # Migration tests (separate DB)
make test-web          # Frontend tests
make test-all          # All tests
make verify            # Full verification (lint + format + all tests)
```

### Test Architecture

- **Backend Integration**: Tests hit FastAPI with MockTokenVerifier
- **BFF Smoke Tests**: Verify header attachment and auth flow
- **Frontend Unit**: Component tests with mocked fetch

## Code Quality

```bash
# Backend
make lint              # Run ruff linter
make fmt               # Format with ruff

# Frontend
make lint-web          # Run ESLint
cd apps/web && npm run lint
```

## Troubleshooting

### Port Conflicts

```bash
# Use alternate ports
POSTGRES_PORT=5433 WEB_PORT=3001 make setup
```

### Missing Schema

```bash
make migrate       # Dev database
make migrate-test  # Test database
```

### Stale Connections

```bash
# Kill idle connections
docker exec <postgres-container> psql -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'nexus_test%' AND state LIKE 'idle%';"
```

## License

Proprietary - All rights reserved.
