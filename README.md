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
│   │   ├── app.py               # FastAPI app factory (no module-level app)
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
├── supabase/                    # Supabase local configuration
│   └── config.toml              # Ports: API=54321, DB=54322
│
├── docker/                      # Docker configs
│   ├── docker-compose.yml       # Local dev services (redis only)
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
- **JWT Verification**: All environments use Supabase JWKS for token verification.

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 20+
- Docker (running)
- [uv](https://github.com/astral-sh/uv) package manager
- Supabase CLI (`brew install supabase/tap/supabase`)

### Setup

```bash
# Full setup (starts Supabase local, installs deps, runs migrations, creates .env)
make setup
```

This will:
1. Start Supabase local (Postgres + Auth + Studio)
2. Create test databases
3. Install Python and Node.js dependencies
4. Run database migrations
5. Create `.env` and `apps/web/.env.local` with Supabase configuration

### Development

```bash
# Start infrastructure services (supabase + redis)
make dev

# In terminal 1: Start API server (http://localhost:8000)
make api

# In terminal 2: Start web frontend (http://localhost:3000)
make web

# In terminal 3 (optional): Start Celery worker
make worker

# Run all tests
make test

# Run backend tests only
make test-back

# Run migration tests (separate database)
make test-migrations

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
# Start infrastructure (supabase + redis)
make dev

# Stop infrastructure
make down

# View docker logs (redis only)
make logs

# Run a migration rollback
make migrate-down
```

## Configuration

### The `.env` File

Running `make setup` creates a `.env` file with your local configuration:

```bash
# Infrastructure ports
REDIS_PORT=6379

# Application config
NEXUS_ENV=local
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres
DATABASE_URL_TEST=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test
DATABASE_URL_TEST_MIGRATIONS=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations
REDIS_URL=redis://localhost:6379/0

# Supabase local configuration
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<generated-by-supabase>
SUPABASE_SERVICE_ROLE_KEY=<generated-by-supabase>

# Supabase auth settings (used by FastAPI)
SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
SUPABASE_AUDIENCES=authenticated
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
| `SUPABASE_JWKS_URL` | Yes | Full URL to Supabase JWKS endpoint |
| `SUPABASE_ISSUER` | Yes | Expected JWT issuer |
| `SUPABASE_AUDIENCES` | Yes | Comma-separated list of allowed audiences |
| `NEXUS_INTERNAL_SECRET` | staging/prod | BFF authentication secret |

#### Celery Worker

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | For worker | Redis connection string (e.g., `redis://localhost:6379/0`) |
| `CELERY_BROKER_URL` | No | Celery broker URL (defaults to `REDIS_URL`) |
| `CELERY_RESULT_BACKEND` | No | Celery result backend URL (defaults to `REDIS_URL`) |

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
4. FastAPI validates JWT via Supabase JWKS and derives user identity

### Security Model

- **Tokens never in localStorage**: Access tokens exist only in server runtime
- **BFF gate**: In staging/prod, FastAPI rejects requests without internal header
- **Visibility masking**: Unauthorized access returns 404 (not 403) to hide existence
- **Supabase JWKS verification**: All environments verify JWTs via Supabase JWKS endpoint

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

## Supabase Local

This project uses Supabase local for development:

- **API**: http://localhost:54321
- **Database**: localhost:54322 (postgres/postgres)
- **Studio**: http://localhost:54323 (database admin UI)
- **Inbucket**: http://localhost:54324 (email testing)

### Supabase Commands

```bash
# Start Supabase local
supabase start

# Stop Supabase local
supabase stop

# View Supabase status
supabase status

# View Supabase logs
supabase logs
```

## API Documentation

When running locally:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Testing

### Commands

```bash
make test              # All tests (backend + migrations + frontend)
make test-back         # Backend tests (excludes migrations)
make test-migrations   # Migration tests (separate DB)
make test-front        # Frontend tests
make verify            # Full verification (lint + format + all tests)
```

### Test Architecture

- **Backend Integration**: Tests use TestTokenVerifier (test-only RSA keypair)
- **BFF Smoke Tests**: Verify header attachment and auth flow
- **Frontend Unit**: Component tests with mocked fetch

## Code Quality

```bash
# Backend
make lint-back         # Run ruff linter
make fmt-back          # Format with ruff

# Frontend
make lint-front        # Run ESLint
make fmt-front         # Fix ESLint issues

# All
make lint              # Run all linters
make fmt               # Format all code
```

## Troubleshooting

### Port Conflicts

Supabase uses fixed ports (54321-54324). If they're in use:
```bash
# Check what's using the ports
lsof -i :54321
lsof -i :54322

# Stop conflicting processes before running setup
```

### Supabase Not Starting

```bash
# Check Docker is running
docker ps

# Check Supabase status
supabase status

# Reset Supabase (deletes local data)
supabase stop
supabase start
```

### Missing Schema

```bash
make migrate       # Dev database
make migrate-test  # Test database
```

### Stale Connections

```bash
# Restart Supabase to clear connections
supabase stop
supabase start
```

## License

Proprietary - All rights reserved.
