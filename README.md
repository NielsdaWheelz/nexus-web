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
│   │       ├── 0002_slice1_ingestion_framework.py  # S1: processing lifecycle, storage
│   │       ├── 0003_slice2_highlights_annotations.py  # S2: highlights, annotations
│   │       └── 0004_slice3_schema.py     # S3: conversations, messages, LLM infrastructure
│   └── alembic.ini
│
├── supabase/                    # Supabase local configuration
│   └── config.toml              # Ports: API=54321, DB=54322
│
├── node/                        # Node.js packages
│   └── ingest/                  # Web article ingestion (Playwright + Readability)
│
├── docker/                      # Docker configs
│   ├── docker-compose.yml       # Local dev services (redis only)
│   ├── docker-compose.worker.yml # Worker service config
│   ├── Dockerfile.api
│   └── Dockerfile.worker        # Worker image (Python + Node.js + Chromium)
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
- **Chat Infrastructure** (S3): Conversations, messages, and LLM integration for AI-assisted reading.
- **Send Message Flow**: Three-phase execution (Prepare → Execute → Finalize) to avoid holding DB transactions during LLM calls.
- **Quote-to-Chat**: Users can include highlights, media, and annotations as context for LLM conversations.

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

# Run Supabase integration tests (auth JWKS + storage)
make test-supabase

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
SUPABASE_SERVICE_KEY=<service-role-key-for-storage>

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

#### Storage (Supabase)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | For storage | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | For storage | Supabase service role key |
| `STORAGE_BUCKET` | No | Storage bucket name (default: `media`) |
| `MAX_PDF_BYTES` | No | Max PDF upload size (default: 100 MB) |
| `MAX_EPUB_BYTES` | No | Max EPUB upload size (default: 50 MB) |
| `STORAGE_TEST_PREFIX` | For tests | Test storage path prefix (e.g., `test_runs/{run_id}/`) |

#### LLM / Chat (S3+)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXUS_KEY_ENCRYPTION_KEY` | For BYOK | Base64-encoded 32-byte key for encrypting user API keys |
| `OPENAI_API_KEY` | For OpenAI | Platform API key for OpenAI models |
| `ANTHROPIC_API_KEY` | For Anthropic | Platform API key for Anthropic models |
| `GEMINI_API_KEY` | For Gemini | Platform API key for Gemini models |
| `ENABLE_STREAMING` | No | Enable SSE streaming endpoints (default: false) |

To generate an encryption key:
```bash
python -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
```

#### Frontend (Next.js)

| Variable | Required | Description |
|----------|----------|-------------|
| `FASTAPI_BASE_URL` | Yes | FastAPI server URL (e.g., `http://localhost:8000`) |
| `NEXUS_INTERNAL_SECRET` | staging/prod | Same as backend |
| `NEXUS_ENV` | No | Environment (default: `local`) |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `NEXT_PUBLIC_ENABLE_STREAMING` | No | Enable SSE streaming chat (default: `0`, set to `1` to enable) |

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

### BFF Proxy

All Next.js API routes use a centralized proxy helper (`apps/web/src/lib/api/proxy.ts`) that:

- Attaches `Authorization: Bearer <token>` from Supabase session
- Attaches `X-Nexus-Internal` header (staging/prod only)
- Forwards `X-Request-ID` for tracing
- Forwards query strings from the original request
- Handles binary and text responses correctly
- Filters request and response headers via allowlists
- Supports SSE streaming passthrough (`{ expectStream: true }`) without buffering
- Propagates abort signals for client disconnect cleanup
- Never exposes cookies, tokens, or internal headers to the browser

**Request header allowlist:** `content-type`, `accept`, `range`, `if-none-match`, `if-modified-since`, `idempotency-key`

**Response header allowlist:** `x-request-id`, `content-type`, `content-length`, `cache-control`, `etag`, `vary`, `content-disposition`, `location`

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

## Image Proxy

External images in web articles are served through a secure image proxy endpoint (`GET /media/image?url=...`) that provides:

### Security Features

- **SSRF Protection**: Blocks requests to private IPs, localhost, link-local addresses, and cloud metadata endpoints
- **URL Validation**: Only allows http/https schemes, ports 80/443, and blocks credentials in URLs
- **Hostname Denylist**: Blocks `.local`, `.internal`, `.lan`, `.home` suffixes
- **Content Validation**: Verifies images with Pillow, rejects SVG (including disguised SVGs)
- **Size Limits**: Max 10 MB per image, 4096x4096 max dimensions

### Caching

- In-memory LRU cache with 64 entry limit and 128 MB byte budget
- ETag support for conditional GET (304 Not Modified)
- Cache-Control: private, max-age=86400 (24 hours)

### Integration

Images in sanitized HTML are automatically rewritten to use the proxy:
```html
<!-- Original -->
<img src="https://example.com/image.png">

<!-- Sanitized -->
<img src="/media/image?url=https%3A%2F%2Fexample.com%2Fimage.png">
```

## Web Article Ingestion

The system supports ingesting web articles by URL with asynchronous processing:

### Workflow

1. **API Request**: `POST /media/from_url` with `{"url": "https://..."}`
2. **Immediate Response**: Returns 202 Accepted with `media_id` and `ingest_enqueued: true`
3. **Background Processing**: Celery worker:
   - Fetches page via Playwright (JS-enabled browser)
   - Extracts content using Mozilla Readability
   - Sanitizes HTML (XSS protection, image proxy rewriting)
   - Generates canonical text for highlighting
   - Handles deduplication by canonical URL
4. **Poll for Status**: `GET /media/{id}` returns `processing_status`

### Running the Worker

```bash
# Terminal 3: Start Celery worker for ingestion
make worker
```

The worker requires Node.js 20+ and Playwright Chromium. On first run:
```bash
cd node/ingest
npm ci
npx playwright install chromium
```

### Docker Worker

```bash
# Build and run worker with docker-compose
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d
```

## Chat / Send Message

The platform supports AI-assisted reading through conversational LLM interactions:

### Sending Messages

```bash
# Send a message (creates new conversation)
POST /conversations/messages
{
  "content": "What is this about?",
  "model_id": "<model-uuid>",
  "key_mode": "auto",  # "auto" | "byok_only" | "platform_only"
  "contexts": [
    {"type": "highlight", "id": "<highlight-uuid>"},
    {"type": "media", "id": "<media-uuid>"}
  ]
}

# Send to existing conversation
POST /conversations/{id}/messages
```

### Key Modes

- **auto** (default): Use user's BYOK key if available, fall back to platform key
- **byok_only**: Only use user's own API key (fails if not configured)
- **platform_only**: Only use platform's API key (counts against daily budget)

### Rate Limits

| Limit | Value | Scope |
|-------|-------|-------|
| Requests per minute | 20 | Per user |
| Concurrent sends | 3 | Per user |
| Daily token budget | 100,000 | Per user (platform keys only) |

### Idempotency

Include `Idempotency-Key` header to prevent duplicate execution on retries:
```bash
curl -X POST /conversations/messages \
  -H "Idempotency-Key: unique-request-id-123" \
  -d '{"content": "...", "model_id": "..."}'
```

### Streaming (SSE)

When `ENABLE_STREAMING=true`, SSE endpoints are available:
```bash
POST /conversations/messages/stream
POST /conversations/{id}/messages/stream
```

Events: `meta` (IDs + provider info), `delta` (content chunks), `done` (final status)

The frontend defaults to streaming when `NEXT_PUBLIC_ENABLE_STREAMING=1` is set and falls back to non-streaming on failure.

### Frontend Chat UI

The chat UI is accessible at `/conversations`:
- **Conversation list**: sidebar with cursor pagination
- **Message thread**: paginated history (oldest first), streaming append
- **Composer**: textarea + model picker + context chips
- **Quote-to-chat**: "send to chat" button on highlight rows in the linked-items pane
- **Search**: keyword search at `/search` across media, fragments, annotations, messages
- **BYOK keys**: manage API keys at `/settings/keys`

### Frontend BFF Routes (S3)

| BFF Route | FastAPI Route | Method |
|-----------|---------------|--------|
| `/api/conversations` | `/conversations` | GET, POST |
| `/api/conversations/[id]` | `/conversations/{id}` | GET, DELETE |
| `/api/conversations/[id]/messages` | `/conversations/{id}/messages` | GET, POST |
| `/api/conversations/[id]/messages/stream` | `/conversations/{id}/messages/stream` | POST (SSE) |
| `/api/conversations/messages` | `/conversations/messages` | POST |
| `/api/conversations/messages/stream` | `/conversations/messages/stream` | POST (SSE) |
| `/api/messages/[messageId]` | `/messages/{messageId}` | DELETE |
| `/api/models` | `/models` | GET |
| `/api/keys` | `/keys` | GET, POST |
| `/api/keys/[keyId]` | `/keys/{keyId}` | DELETE |
| `/api/search` | `/search` | GET |

## API Documentation

When running locally:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Key API Endpoints

| Category | Endpoints |
|----------|-----------|
| Libraries | `GET/POST /libraries`, `PATCH/DELETE /libraries/{id}` |
| Media | `GET /media/{id}`, `POST /media/from_url`, `POST /media/upload/init` |
| Highlights | `POST/GET /fragments/{id}/highlights`, `PATCH/DELETE /highlights/{id}` |
| Annotations | `PUT/DELETE /highlights/{id}/annotation` |
| Conversations | `GET/POST /conversations`, `GET/DELETE /conversations/{id}` |
| Messages | `GET /conversations/{id}/messages`, `DELETE /messages/{id}` |
| Send Message | `POST /conversations/messages`, `POST /conversations/{id}/messages` |
| Models & Keys | `GET /models`, `GET/POST/DELETE /keys` |

See `python/README.md` for the complete endpoint reference.

## Testing

### Commands

```bash
make test              # All tests (backend + migrations + frontend)
make test-back         # Backend tests (excludes migrations)
make test-migrations   # Migration tests (separate DB)
make test-supabase     # Supabase auth/storage integration tests (opt-in)
make test-front        # Frontend tests
make verify            # Full verification (lint + format + all tests)
```

Backend tests are hermetic: they start their own Postgres + Redis on free ports,
run migrations, and tear everything down. If you want to reuse existing services
instead, use `make test-back-no-services` or `make test-migrations-no-services`.
To override the hermetic ports, set `TEST_POSTGRES_PORT` and/or `TEST_REDIS_PORT`.
Hermetic test env variables are centralized in `scripts/test_env.sh`.

Supabase integration tests start and stop Supabase local by default. Set
`SUPABASE_KEEP_RUNNING=1` to keep it running after the test run.

### Test Architecture

- **Backend Integration**: Tests use `MockJwtVerifier` (test-only RSA keypair)
- **BFF Smoke Tests**: Verify header attachment and auth flow
- **Frontend Unit**: Vitest + happy-dom for component and utility tests
- **Proxy Tests**: Comprehensive tests for BFF proxy behavior including:
  - Authentication (401 when no session)
  - Header allowlist/blocklist enforcement
  - Query string forwarding
  - Binary response handling
  - Request ID propagation
  - SSE streaming passthrough (non-buffered delivery)
  - Idempotency-Key header forwarding
  - Abort signal propagation

Frontend tests use `proxyToFastAPIWithDeps` for testability with injectable dependencies.

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