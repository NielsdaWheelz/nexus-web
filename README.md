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
│   │   └── db/                  # Database layer
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
# Full setup (installs deps, starts services, runs migrations)
make setup

# Or step by step:
cd docker && docker compose up -d
cd python && uv sync --all-extras
cd migrations && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev \
  uv run --project ../python alembic upgrade head
```

### Development

```bash
# Start services
make dev

# Run API server
make api

# Run tests
make test

# Run linter
make lint

# Format code
make fmt
```

### Verify Everything

```bash
./scripts/agency_verify.sh
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NEXUS_ENV` | No | Environment: `local`, `test`, `staging`, `prod` |
| `NEXUS_INTERNAL_SECRET` | Prod only | BFF authentication secret |

### Database URL Format

```
postgresql+psycopg://user:password@host:port/database
```

Example:
```
postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev
```

## API Documentation

When running locally, API docs are available at:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Testing

```bash
cd python

# Run all tests
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test \
  uv run pytest -v

# Run unit tests only (no database)
DATABASE_URL=postgresql+psycopg://localhost/test \
  uv run pytest tests/test_health.py tests/test_errors.py -v

# Run migration tests
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test \
  uv run pytest tests/test_migrations.py -v
```

## Code Quality

```bash
cd python

# Lint
uv run ruff check .

# Format
uv run ruff format .
```

## License

Proprietary - All rights reserved.
