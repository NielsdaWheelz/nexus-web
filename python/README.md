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
│       ├── health.py    # Health check
│       ├── me.py        # Current user endpoint
│       ├── libraries.py # Library CRUD + library-media
│       └── media.py     # Media read endpoints
├── auth/          # Authentication
│   ├── middleware.py  # Auth middleware
│   └── verifier.py    # JWT verifiers (SupabaseJwksVerifier, MockTokenVerifier)
├── db/            # Database layer
│   ├── engine.py  # SQLAlchemy engine
│   └── session.py # Session management
├── schemas/       # Pydantic request/response models
│   ├── library.py # Library schemas
│   └── media.py   # Media and fragment schemas
└── services/      # Business logic
    ├── bootstrap.py   # User/library bootstrap
    ├── libraries.py   # Library domain logic
    └── media.py       # Media visibility + retrieval
```

## API Endpoints

### Authenticated Endpoints (require bearer token)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me` | Get current user info |
| GET | `/libraries` | List viewer's libraries |
| POST | `/libraries` | Create a new library |
| PATCH | `/libraries/{id}` | Rename a library |
| DELETE | `/libraries/{id}` | Delete a library |
| GET | `/libraries/{id}/media` | List media in library |
| POST | `/libraries/{id}/media` | Add media to library |
| DELETE | `/libraries/{id}/media/{media_id}` | Remove media from library |
| GET | `/media/{id}` | Get media by ID (visibility enforced) |
| GET | `/media/{id}/fragments` | Get fragments for media (visibility enforced) |

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |

## Architecture

### Service/Route Separation

Routes are transport-only. All domain logic lives in `services/`:

```python
# Routes: extract viewer, call service, return response
@router.post("/libraries", status_code=201)
def create_library(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = libraries_service.create_library(db, viewer.user_id, body.name)
    return success_response(result.model_dump(mode="json"))
```

Routes may not:
- Contain domain logic
- Perform raw DB operations (no `db.execute()`)
- Import SQLAlchemy modules (except `Session` type annotation)

### Default Library Closure Invariant

When media is added to any library:
- Media is automatically added to all members' default libraries

When media is removed from default library:
- Media is also removed from all single-member libraries owned by that user

## Usage

This package is imported by:
- `apps/api/` - FastAPI server
- `apps/worker/` - Celery worker (future)

## Development

From the repo root, use Make commands:

```bash
make test              # Run tests (excludes migration tests)
make test-migrations   # Run migration tests (separate database)
make test-all          # Run all tests
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
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5434/nexus_test \
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
- **Structural tests**: AST-based tests verify route files follow separation rules

## Install as Editable

```bash
pip install -e .
```
