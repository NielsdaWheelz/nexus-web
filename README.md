# Nexus

A reading and annotation platform.

## Project Structure

```
nexus/
├── apps/                        # Application entrypoints
│   ├── api/                     # FastAPI server (thin launcher)
│   ├── web/                     # Next.js BFF + frontend
│   └── worker/                  # Celery worker (placeholder)
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

# Run all tests
make test-all

# Run backend tests only
make test

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
5. Open http://localhost:3000

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
