# Nexus Python Package

Shared Python code for the Nexus platform.

## Structure

```
nexus/
├── config.py      # Pydantic settings (loads from .env)
├── errors.py      # Error codes and exceptions
├── responses.py   # Response envelope helpers (includes request_id)
├── logging.py     # Structured logging with structlog
├── app.py         # FastAPI app creation + middleware setup
├── api/           # HTTP routers
│   ├── deps.py    # FastAPI dependencies
│   └── routes/    # Route handlers
│       ├── health.py    # Health check
│       ├── me.py        # Current user endpoint
│       ├── libraries.py # Library CRUD + library-media
│       └── media.py     # Media read endpoints
├── auth/          # Authentication
│   ├── middleware.py  # Auth middleware
│   ├── permissions.py # Authorization predicates (can_read_media, etc.)
│   └── verifier.py    # JWT verifiers (SupabaseJwksVerifier, MockTokenVerifier)
├── middleware/    # Request middleware
│   ├── __init__.py
│   └── request_id.py  # X-Request-ID generation and logging
├── db/            # Database layer
│   ├── engine.py  # SQLAlchemy engine
│   ├── models.py  # SQLAlchemy ORM models
│   └── session.py # Session management
├── schemas/       # Pydantic request/response models
│   ├── library.py # Library schemas
│   └── media.py   # Media and fragment schemas
├── services/      # Business logic
│   ├── bootstrap.py     # User/library bootstrap
│   ├── capabilities.py  # Media capabilities derivation
│   ├── libraries.py     # Library domain logic
│   ├── media.py         # Media visibility + retrieval
│   └── upload.py        # File upload + ingest logic
└── storage/       # Supabase Storage client
    ├── client.py    # StorageClient abstraction + FakeStorageClient
    └── paths.py     # Storage path building utilities
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
| POST | `/media/upload/init` | Initialize file upload (PDF/EPUB) |
| POST | `/media/{id}/ingest` | Confirm upload and process file |
| GET | `/media/{id}/file` | Get signed download URL |

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |

## Architecture

### Request Tracing (X-Request-ID)

Every request gets a unique `X-Request-ID` for tracing:

- Generated if not present in request
- Preserved and normalized if valid (UUID lowercase, alphanumeric preserved)
- Included in all response headers
- Included in error response bodies for easy debugging
- Propagated through BFF → FastAPI → Celery logs

Example error response:
```json
{
  "error": {
    "code": "E_MEDIA_NOT_FOUND",
    "message": "Media not found",
    "request_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Structured Logging

All logs are JSON-formatted via structlog with consistent fields:
- `request_id`: Correlation ID for the request
- `user_id`: Authenticated user (when available)
- `timestamp`: ISO8601 formatted
- `method`, `path`, `status_code`, `duration_ms` for access logs

### Authorization Predicates

Visibility checks use canonical predicates in `nexus.auth.permissions`:

```python
from nexus.auth.permissions import can_read_media, is_library_admin

# Check media readability
if can_read_media(session, viewer_id, media_id):
    # User can read
    
# Check library admin role
if is_library_admin(session, viewer_id, library_id):
    # User is admin
```

Available predicates:
- `can_read_media(session, viewer_id, media_id)` - media in any library user belongs to
- `can_read_media_bulk(session, viewer_id, media_ids)` - batch check (single query)
- `is_library_admin(session, viewer_id, library_id)` - admin role in library
- `is_admin_of_any_containing_library(session, viewer_id, media_id)` - admin of any library with media
- `is_library_member(session, viewer_id, library_id)` - any role in library

### Capabilities Derivation

Media capabilities are derived from status and metadata:

```python
from nexus.services.capabilities import derive_capabilities

caps = derive_capabilities(
    kind="pdf",
    processing_status="pending",
    last_error_code=None,
    media_file_exists=True,
    external_playback_url_exists=False,
)

# caps.can_read == True (PDF can render before extraction)
# caps.can_download_file == True (file exists)
```

Capabilities:
- `can_read` - can render primary content pane
- `can_highlight` - can create highlights
- `can_quote` - can quote-to-chat
- `can_search` - included in search results
- `can_play` - has playable external URL
- `can_download_file` - can download original file

### Storage Client

File storage uses Supabase Storage with signed URLs:

```python
from nexus.storage import get_storage_client, build_storage_path

client = get_storage_client()

# Sign upload URL
signed = client.sign_upload(path, content_type="application/pdf")
# Returns { path, token } for uploadToSignedUrl()

# Sign download URL
url = client.sign_download(path, expires_in=300)

# Build storage paths (applies test prefix automatically)
path = build_storage_path(media_id, "pdf")
# Production: media/{id}/original.pdf
# Test: test_runs/{run_id}/media/{id}/original.pdf
```

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
