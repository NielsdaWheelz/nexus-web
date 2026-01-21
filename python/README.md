# Nexus Python Package

Shared Python code for the Nexus platform.

## Structure

```
nexus/
├── config.py      # Pydantic settings (loads from .env)
├── errors.py      # Error codes and exceptions
├── responses.py   # Response envelope helpers
├── app.py         # FastAPI app creation
├── api/           # HTTP routers
│   ├── deps.py    # FastAPI dependencies
│   └── routes/    # Route handlers
├── auth/          # Authentication
│   ├── middleware.py  # Auth middleware
│   └── verifier.py    # JWT verifiers (SupabaseJwksVerifier, MockTokenVerifier)
├── db/            # Database layer
│   ├── engine.py  # SQLAlchemy engine
│   └── session.py # Session management
└── services/      # Business logic
    └── bootstrap.py   # User/library bootstrap
```

## Usage

This package is imported by:
- `apps/api/` - FastAPI server
- `apps/worker/` - Celery worker (future)

## Development

From the repo root, use Make commands:

```bash
make test              # Run tests (excludes migration tests)
make test-migrations   # Run migration tests (separate database)
make test-all          # Run all tests (80 tests)
make lint              # Run linter
make fmt               # Format code
make verify            # Full verification
```

Or run directly:

```bash
cd python

# Install dependencies
uv sync --all-extras

# Run tests (requires .env or DATABASE_URL)
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5433/nexus_test \
  NEXUS_ENV=test uv run pytest -v

# Lint and format
uv run ruff check .
uv run ruff format .
```

## Test Architecture

- **Savepoint isolation**: Most tests use `db_session` fixture with auto-rollback
- **Direct DB access**: Tests needing multiple connections use `direct_db` fixture
- **Migration tests**: Run on separate `nexus_test_migrations` database
- **Mock auth**: Tests use `MockTokenVerifier` (local RSA keypair, same validation as production)

## Install as Editable

```bash
pip install -e .
```
