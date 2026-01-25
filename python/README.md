# Nexus Python Package

Shared Python code for the Nexus platform.

## Structure

```
nexus/
├── config.py      # Pydantic settings (loads from .env)
├── errors.py      # Error codes and exceptions
├── responses.py   # Response envelope helpers (includes request_id)
├── logging.py     # Structured logging with structlog
├── app.py         # FastAPI app factory + middleware setup (no module-level app)
├── api/           # HTTP routers
│   ├── deps.py    # FastAPI dependencies
│   └── routes/    # Route handlers
│       ├── health.py        # Health check
│       ├── me.py            # Current user endpoint
│       ├── libraries.py     # Library CRUD + library-media
│       ├── media.py         # Media read endpoints
│       ├── highlights.py    # Highlight/annotation CRUD (S2)
│       ├── conversations.py # Conversation/message CRUD (S3)
│       ├── keys.py          # User API key management (S3)
│       ├── models.py        # LLM model registry (S3)
│       └── search.py        # Keyword search (S3, PR-06)
├── auth/          # Authentication
│   ├── middleware.py  # Auth middleware
│   ├── permissions.py # Authorization predicates (can_read_media, etc.)
│   └── verifier.py    # JWT verifier (SupabaseJwksVerifier)
├── middleware/    # Request middleware
│   ├── __init__.py
│   └── request_id.py  # X-Request-ID generation and logging
├── db/            # Database layer
│   ├── engine.py  # SQLAlchemy engine
│   ├── models.py  # SQLAlchemy ORM models (incl. S3 conversation models)
│   └── session.py # Session management
├── schemas/       # Pydantic request/response models
│   ├── library.py      # Library schemas
│   ├── media.py        # Media and fragment schemas
│   ├── highlights.py   # Highlight and annotation schemas (S2)
│   ├── conversation.py # Conversation and message schemas (S3)
│   ├── keys.py         # Model registry and user API key schemas (S3)
│   └── search.py       # Search result schemas (S3, PR-06)
├── services/      # Business logic
│   ├── bootstrap.py     # User/library bootstrap
│   ├── capabilities.py  # Media capabilities derivation
│   ├── highlights.py    # Highlight/annotation CRUD operations (S2)
│   ├── libraries.py     # Library domain logic
│   ├── media.py         # Media visibility + retrieval + URL-based creation
│   ├── upload.py        # File upload + ingest logic
│   ├── url_normalize.py # URL validation and normalization (S2)
│   ├── conversations.py # Conversation/message CRUD (S3)
│   ├── shares.py        # Conversation sharing invariants (S3)
│   ├── contexts.py      # Message context management (S3)
│   ├── crypto.py        # XChaCha20-Poly1305 encryption for BYOK keys (S3)
│   ├── user_keys.py     # User API key management (S3)
│   ├── models.py        # LLM model registry and availability (S3)
│   └── search.py        # Keyword search with visibility filtering (S3, PR-06)
│   └── llm/             # LLM adapter layer (S3 PR-04)
│       ├── __init__.py       # Public exports
│       ├── types.py          # Turn, LLMRequest, LLMResponse, LLMChunk, LLMUsage
│       ├── errors.py         # LLMError, LLMErrorClass, error classification
│       ├── adapter.py        # Abstract LLMAdapter base class
│       ├── router.py         # Adapter selection + error normalization
│       ├── prompt.py         # Provider-agnostic prompt rendering
│       ├── openai_adapter.py # OpenAI implementation
│       ├── anthropic_adapter.py # Anthropic implementation
│       └── gemini_adapter.py # Gemini implementation
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
| POST | `/media/from_url` | Create provisional web_article from URL (S2) |
| POST | `/media/upload/init` | Initialize file upload (PDF/EPUB) |
| POST | `/media/{id}/ingest` | Confirm upload and process file |
| GET | `/media/{id}/file` | Get signed download URL |
| POST | `/fragments/{id}/highlights` | Create highlight (S2) |
| GET | `/fragments/{id}/highlights` | List highlights for fragment (S2) |
| GET | `/highlights/{id}` | Get highlight by ID (S2) |
| PATCH | `/highlights/{id}` | Update highlight (S2) |
| DELETE | `/highlights/{id}` | Delete highlight (S2) |
| PUT | `/highlights/{id}/annotation` | Upsert annotation (S2) |
| DELETE | `/highlights/{id}/annotation` | Delete annotation (S2) |
| GET | `/conversations` | List viewer's conversations (S3) |
| POST | `/conversations` | Create a new conversation (S3) |
| GET | `/conversations/{id}` | Get conversation by ID (S3) |
| DELETE | `/conversations/{id}` | Delete conversation (S3) |
| GET | `/conversations/{id}/messages` | List messages in conversation (S3) |
| DELETE | `/messages/{id}` | Delete a message (S3) |
| GET | `/models` | List available LLM models for current user (S3) |
| GET | `/keys` | List user's API keys (safe fields only) (S3) |
| POST | `/keys` | Add or update API key for provider (S3) |
| DELETE | `/keys/{id}` | Revoke an API key (S3) |
| POST | `/keys/{id}/test` | Test an API key against its provider (S3) |
| GET | `/search` | Keyword search across visible content (S3, PR-06) |

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |

## Architecture

### JWT Verification

All environments use Supabase JWKS for JWT verification:
- Local/test: Supabase local at `http://127.0.0.1:54321`
- Staging/prod: Supabase cloud

The `SupabaseJwksVerifier` validates:
- Signature via JWKS
- Algorithm: RS256 only
- Expiration with ±60s clock skew
- Issuer matches configured value
- Audience is in configured list
- Subject is valid UUID

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

### LLM Adapter Layer (S3 PR-04)

Provider-agnostic LLM integration supporting OpenAI, Anthropic, and Gemini:

```python
from nexus.services.llm import LLMRouter, LLMRequest, Turn
import httpx

# Create router with feature flags
async with httpx.AsyncClient() as client:
    router = LLMRouter(
        client,
        enable_openai=True,
        enable_anthropic=True,
        enable_gemini=True,
    )
    
    # Build request
    request = LLMRequest(
        model_name="gpt-4",
        messages=[
            Turn(role="system", content="You are helpful."),
            Turn(role="user", content="Hello!"),
        ],
        max_tokens=100,
        temperature=0.7,
    )
    
    # Non-streaming generation
    response = await router.generate("openai", request, api_key="sk-...")
    print(response.text)
    
    # Streaming generation
    async for chunk in router.generate_stream("openai", request, api_key="sk-..."):
        print(chunk.delta_text, end="")
        if chunk.done:
            print(f"\nUsage: {chunk.usage}")
```

**Prompt Rendering:**

```python
from nexus.services.llm import render_prompt, validate_prompt_size, Turn

# Render prompt with context
turns = render_prompt(
    user_content="What does this mean?",
    history=[Turn(role="user", content="Previous question")],
    context_blocks=["Context block 1", "Context block 2"],
)

# Validate size before sending
validate_prompt_size(turns)  # Raises PromptTooLargeError if > 100k chars
```

**Error Handling:**

```python
from nexus.services.llm import LLMError, LLMErrorClass

try:
    response = await router.generate("openai", request, api_key="sk-...")
except LLMError as e:
    if e.error_class == LLMErrorClass.RATE_LIMIT:
        # Handle rate limit
    elif e.error_class == LLMErrorClass.INVALID_KEY:
        # Handle invalid key
```

Error classes: `INVALID_KEY`, `RATE_LIMIT`, `CONTEXT_TOO_LARGE`, `TIMEOUT`, `PROVIDER_DOWN`, `MODEL_NOT_AVAILABLE`

**Configuration (environment variables):**

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_OPENAI` | Enable OpenAI provider | `true` |
| `ENABLE_ANTHROPIC` | Enable Anthropic provider | `true` |
| `ENABLE_GEMINI` | Enable Gemini provider | `true` |
| `OPENAI_API_KEY` | Platform OpenAI key | - |
| `ANTHROPIC_API_KEY` | Platform Anthropic key | - |
| `GEMINI_API_KEY` | Platform Gemini key | - |

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

### Keyword Search (PR-06)

The `/search` endpoint provides PostgreSQL full-text search across all user-visible content:

```python
# Search with default parameters
GET /search?q=python+programming

# Search with scope and type filtering
GET /search?q=test&scope=library:UUID&types=media,fragment

# Search with pagination
GET /search?q=test&limit=10&cursor=BASE64_CURSOR
```

**Searchable Content Types:**
- `media` - Media titles
- `fragment` - Document fragment canonical_text
- `annotation` - Annotation body text
- `message` - Conversation message content

**Scopes:**
- `all` - All visible content (default)
- `media:<id>` - Content anchored to specific media
- `library:<id>` - Content in media belonging to library
- `conversation:<id>` - Messages within specific conversation

**Visibility Enforcement:**
- Media/fragments: visible via library membership
- Annotations: owner-only in S3
- Messages: visible via conversation ownership or sharing
- Pending messages are never searchable
- Search never leaks invisible content

**Query Semantics:**
- Uses PostgreSQL `websearch_to_tsquery` for natural syntax
- Supports quoted phrases, `-` exclusions, implicit AND
- Queries < 2 chars return empty results
- All-stopword queries return empty results

**Response Format:**
```json
{
  "results": [
    {
      "type": "media",
      "id": "uuid",
      "score": 0.85,
      "snippet": "...highlighted text...",
      "title": "Media Title"
    },
    {
      "type": "fragment",
      "id": "uuid",
      "score": 0.72,
      "snippet": "...matched text...",
      "media_id": "uuid",
      "idx": 0
    }
  ],
  "page": {
    "has_more": true,
    "next_cursor": "encoded_cursor"
  }
}
```

## Usage

This package is imported by:
- `apps/api/` - FastAPI server
- `apps/worker/` - Celery worker (future)

## Development

From the repo root, use Make commands:

```bash
make test-back         # Run tests (excludes migration tests)
make test-migrations   # Run migration tests (separate database)
make test-supabase     # Supabase auth/storage integration tests (opt-in)
make lint-back         # Run linter
make fmt-back          # Format code
make verify            # Full verification
```

`make test-back` and `make test-migrations` are hermetic: they start Postgres + Redis
on free ports, run migrations, and shut everything down automatically.
`make test-supabase` starts Supabase local for JWKS/storage integration tests.
Hermetic test env variables are centralized in `scripts/test_env.sh`.

Or run directly:

```bash
cd python

# Install dependencies
uv sync --all-extras

# Run tests against existing services (bypass hermetic wrapper)
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test \
  NEXUS_ENV=test uv run pytest -v

# Lint and format
uv run ruff check .
uv run ruff format .
```

## Test Architecture

- **Savepoint isolation**: Most tests use `db_session` fixture with auto-rollback
- **Direct DB access**: Tests needing multiple connections use `direct_db` fixture
- **Migration tests**: Run on separate `nexus_test_migrations` database
- **Test auth**: Tests use `MockJwtVerifier` (local RSA keypair, same validation as production)
- **Structural tests**: AST-based tests verify route files follow separation rules

## Install as Editable

```bash
pip install -e .
```
