# Nexus

A reading and annotation platform.

## Project Structure

```
nexus/
├── apps/                        # Application entrypoints
│   ├── api/                     # FastAPI server (thin launcher)
│   ├── web/                     # Next.js BFF + frontend
│   └── worker/                  # Postgres queue worker
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
│   │   ├── logging.py            # structlog + ContextVars (request, flow, stream)
│   │   └── services/            # Business logic services (incl. redact.py)
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
│   │       ├── 0004_slice3_schema.py     # S3: conversations, messages, LLM infrastructure
│   │       ├── 0005_*.py                # S3: tsvector/search indexes
│   │       ├── 0006_pr09_provider_request_id.py  # S3: message_llm.provider_request_id
│   │       ├── 0007_slice4_library_sharing.py    # S4: library sharing schema + provenance
│   │       ├── 0008_slice5_epub_toc_nodes.py     # S5: EPUB TOC snapshot schema
│   │       ├── 0009_slice6_typed_highlight_data_foundation.py  # S6: typed highlight + PDF artifacts
│   │       ├── 0010_slice7_podcast_backend_foundation.py       # S7: podcast foundation tables
│   │       ├── 0011_slice7_podcast_subscription_sync_lifecycle.py # S7: async subscription sync state
│   │       ├── 0012_slice7_podcast_unsubscribe_modes.py        # S7: unsubscribe retention modes
│   │       ├── 0013_slice7_pr03_transcript_invariants.py       # S7 PR-03: strict transcript timing invariants
│   │       ├── 0014_slice7_pr04_polling_orchestration.py       # S7 PR-04: scheduled poll telemetry + singleton leasing
│   │       ├── 0015_slice5_epub_nav_locations.py               # S5 PR-07: persisted EPUB nav locations
│   │       ├── 0016_reader_profiles_and_media_state.py         # Reader profile defaults + per-media state
│   │       ├── 0017_reader_profile_default_view_mode.py        # Reader profile view mode default/backfill
│   │       ├── 0018_reader_media_state_locator_bounds.py       # Reader state locator bounds hardening
│   │       ├── 0019_media_metadata_and_authors.py             # Media metadata + authors
│   │       ├── 0020_conversation_titles.py                    # Conversation title column
│   │       ├── 0021_podcast_transcription_job_lifecycle.py    # S7: podcast transcription job lifecycle
│   │       ├── 0022_user_email_display_name.py                # User email + display_name columns
│   │       ├── 0023_podcast_transcription_request_reason.py   # Podcast transcript request reason contract
│   │       └── 0024_podcast_transcript_state_versioning_semantic.py  # Transcript state bridge, versioned artifacts, semantic chunk search tables
│   └── alembic.ini
│
├── supabase/                    # Supabase local configuration
│   └── config.toml              # Ports: API=54321, DB=54322
│
├── node/                        # Node.js packages
│   └── ingest/                  # Web article ingestion (fetch + Readability)
│
├── docker/                      # Docker configs
│   ├── docker-compose.yml       # Local dev compose placeholder
│   ├── docker-compose.worker.yml # Worker service config
│   ├── Dockerfile.api
│   └── Dockerfile.worker        # Worker image (Python + Node.js)
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

- **BFF Pattern**: Browser → Next.js → FastAPI for non-streaming requests.
- **Direct Streaming** (PR-08): Browser → FastAPI for SSE streaming (bypasses BFF for reliability).
- **Single Python Package**: `python/nexus/` is imported by both API and worker.
- **Auth Flow**: Supabase auth → Next.js session cookies → Bearer token to FastAPI.
- **Stream Token Auth** (PR-08): Short-lived HS256 JWTs for direct browser→FastAPI SSE connections.
- **Visibility Enforcement**: All authorization happens in FastAPI, never in Next.js.
- **JWT Verification**: All environments use Supabase JWKS for token verification.
- **Chat Infrastructure** (S3): Conversations, messages, and LLM integration for AI-assisted reading. Conversation titles are first-class (`conversations.title`): default `"Chat"` for empty threads, then derived from the first user message when the thread receives its first send.
- **Library Sharing** (S4): Multi-user library membership, invitations, and shared visibility. Canonical visibility predicates enforce S4 provenance rules for media (non-default membership, intrinsic, active closure edge), conversations (owner/public/library-shared with dual membership), and highlights (media visibility + library intersection).
- **Send Message Flow**: Three-phase execution (Prepare → Execute → Finalize) to avoid holding DB transactions during LLM calls.
- **Quote-to-Chat**: Users can include highlights, media, and annotations as context for LLM conversations; the UI opens chat context in a side pane when pane dispatch succeeds.
- **In-App Pane Workspace**: Authenticated pages render inside a URL-encoded multi-group workspace (`ws` query param, schema v2). Each group holds tabbed panes with resize handles and keyboard navigation. Mobile contract: bottom navigation replaces desktop sidebar, a Tabs sheet controls open-tab switching, only the active group is visible, pane/page chrome auto-hides on downward scroll, and two-pane surfaces expose the secondary pane via a floating top-right drawer toggle. Supported pane routes: `/libraries`, `/libraries/{id}`, `/media/{id}`, `/conversations`, `/conversations/{id}`, `/discover`, `/documents`, `/podcasts`, `/videos`, `/search`, `/settings`, `/settings/reader`, `/settings/keys`. Groups are capped at 4, tabs at 12 per group (24 total).
- **Pane Title Resolution**: Tab labels are resolved via a descriptor pipeline (`runtime_page` → `resource_cache` → `title_hint` → `route_static` → `safe_fallback`) rather than URL-slicing. Route metadata provides canonical static titles and `resourceRef` keys for cache lookups.
- **Pane Open Hints + Cache**: `requestOpenInAppPane(href, { titleHint?, resourceRef? })` can provide zero-jank initial labels. Workspace layout stays in the URL; resource-title cache persists separately in `localStorage` (`nexus.workspace.resource-title-cache.v1`) to avoid URL bloat.
- **EPUB Extraction** (S5): Deterministic chapter fragment materialization from EPUB archives with TOC snapshot, title fallback, resource rewriting, archive safety enforcement, and persisted canonical navigation locations.
- **EPUB Reader** (S5 PR-05 + hardening): Reader navigation is section-based (`loc` query param) via unified navigation payload (`sections` + TOC links). Dropdown and TOC resolve through the same section ids, with in-fragment anchor targeting preserved for TOC leaf navigation.
- **EPUB Highlights Hardening**: Linked-items now support explicit scope modes (`This chapter` aligned vs `Entire book` list), deterministic cross-chapter ordering (`fragment_idx`, `start_offset`, `end_offset`, `created_at`, `id`), and a paginated media-wide highlight endpoint for book mode.
- **Reader Settings + Resume State**: Reader preferences are split into user-level defaults (`reader_profile`) and per-media overrides/progress (`reader_media_state`) with strict schema validation (`extra="forbid"`), DB bounds checks, and explicit locator contracts (`fragment_offset`, `epub_section`, `pdf_page`).
- **Web Text-Anchor Resume**: Web-article resume stores canonical text offsets instead of raw viewport pixels, so restored position survives reflow (font size/line-height changes) and remains stable across desktop/mobile layouts.
- **Media Catalog Aggregation**: `GET /media` provides visibility-safe, cross-library media listing with server-side kind/search filtering and keyset pagination (`updated_at DESC, id DESC`) to avoid client fanout over high library counts.
- **PDF Reader** (S6 PR-07): The web reader uses `pdfjs-dist` `PDFViewer` primitives (official text + annotation layers, `PDFLinkService`, vertical continuous scroll) so text selection, internal/external links, and large-document scrolling stay aligned with upstream PDF.js behavior.
- **PDF Reader Alignment Hardening**: `PdfReader` enforces PDF.js `content-box` CSS invariants, defers initial scale/page application until viewer pages are ready (avoids invalid page warnings), and degrades to area-based bounds when text-layer/canvas geometry drifts beyond tolerance.
- **PDF Linked-Items Adapters + Scope**: Linked-items now use explicit renderer adapters (`HtmlAnchorProvider` / `PdfAnchorProvider`) and typed coordinate transforms (`page` -> `viewer-scroll` -> `pane`) to avoid implicit cross-component `getBoundingClientRect` math; PDF exposes explicit scope controls (`This page` aligned mode, `Entire document` index/list mode) backed by stable ordering keyset semantics (`page_number`, `sort_top`, `sort_left`, `created_at`, `id`).
- **Shared Surface Chrome**: Pane/page headers now use a single `SurfaceHeader` primitive (title, back, previous/next nav, actions, and options menu), with reader controls externalized from `PdfReader` so media/library/chat surfaces share non-scroll-coupled navigation chrome and a consistent options interaction model. Mobile headers hide meta/subtitle for compactness via a JS-driven `.mobile` class aligned with `MOBILE_MAX_WIDTH_PX`. Media toolbars use `ResponsiveToolbar` with priority-based items: primary actions show as icon-only buttons on mobile, secondary actions collapse into an overflow menu.
- **Podcast Sync Architecture** (S7): `POST /podcasts/subscriptions` remains control-plane only (subscribe + enqueue). `DELETE /podcasts/subscriptions/{podcast_id}` applies explicit unsubscribe retention modes (`mode=1|2|3`). Episode ingest is metadata-first (`processing_status='pending'`) with explicit transcript admission via `POST /media/{id}/transcript/request` (dry-run forecast + quota-aware enqueue).
- **Podcast Transcription Pipeline** (S7 PR-03): transcript segments are sourced from transcription-provider output (Deepgram), not feed payload transcript fields. Diarized transcription falls back to non-diarized output, transcript text is canonicalized (NFC + whitespace normalization), and persisted segment timing is strictly validated (`t_start_ms < t_end_ms`).
- **Podcast Active Polling Orchestration** (S7 PR-04): Worker scheduler loop enqueues periodic active-subscription polling. Runs are singleton-safe via durable lease rows, stale `running` subscription sync claims are reclaimable, and each run persists deterministic operator telemetry (`processed_count`, `failed_count`, `skipped_count`, `scanned_count`, failure-code breakdown).
- **User Identity**: Email is synced from Supabase JWT on every authenticated request via bootstrap upsert. Users can set a display name via `PATCH /me`. Library member/invite lists are enriched with email and display_name. User search (`GET /users/search`) matches by email prefix or display_name substring for invite-by-email flows.
- **Reader Implementation Notes**: See `docs/reader-implementation.md` for the current reader-settings/resume architecture and regression coverage contract.

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 22+
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
# Start infrastructure services (supabase local)
make dev

# In terminal 1: Start API server (http://localhost:8000)
make api

# In terminal 2: Start web frontend (http://localhost:3000)
make web

# In terminal 3 (optional): Start background worker
make worker

# Run all tests
make test

# Run backend tests only
make test-back

# Run migration tests (separate database)
make test-migrations

# Run Supabase integration tests (auth JWKS + storage)
make test-supabase

# Run E2E browser tests (Playwright)
make test-e2e

# Seed development data (creates fixture media)
make seed
```

### E2E Test Seeding

`e2e/` tests use Playwright `globalSetup` to bootstrap deterministic seed data before any
project starts:

- seeds/refreshes E2E auth user (`e2e/seed-e2e-user.ts`)
- seeds PDF media fixtures (quote-ready + password-protected failure) via
  `python/scripts/seed_e2e_data.py`
- seeds deterministic non-PDF linked-items media with highlights
- quote-to-chat E2E assertions for non-PDF linked items validate in-app pane open behavior (`Close pane` control present in-page, no browser popup)
- seeds a test API key (provider=openai) so the models endpoint returns data
- seeds a 3-chapter EPUB for EPUB reader tests
- seeds dedicated reader-resume fixtures (web + EPUB + PDF)
- writes:
  - `e2e/.seed/pdf-media.json` (PDF reader specs)
  - `e2e/.seed/non-pdf-media.json` (non-PDF linked-items specs)
  - `e2e/.seed/epub-media.json` (EPUB reader specs)
  - `e2e/.seed/youtube-media.json` (YouTube transcript media specs)
  - `e2e/.seed/reader-resume-media.json` (cross-media reader resume specs)

`globalSetup` loads root `.env` and `.dev-ports` automatically so direct runs like
`cd e2e && bun test -- tests/pdf-reader.spec.ts --project=chromium` behave like `make test-e2e`.

Useful targeted E2E runs:

```bash
cd e2e
bun test -- tests/pdf-reader.spec.ts --project=chromium
bun test -- tests/pane-chrome.spec.ts --project=chromium
bun test -- tests/non-pdf-linked-items.spec.ts --project=chromium
bun test -- tests/epub.spec.ts --project=chromium
bun test -- tests/youtube-transcript.spec.ts --project=chromium
bun test -- tests/reader-resume.spec.ts --project=chromium
bun test -- tests/pdf-reader.spec.ts --grep "highlights on non-active page are visible immediately in document scope and click navigates to projected target" --project=chromium
```

For fast local reruns when seed state is known-good:

```bash
cd e2e
SKIP_SEED=1 bun test -- tests/pdf-reader.spec.ts --project=chromium
SKIP_SEED=1 bun test -- tests/epub.spec.ts --project=chromium
```

Runtime CSP verification profile (production Next runtime + CSP enabled):

```bash
cd e2e
bun run test:csp -- tests/youtube-transcript.csp.spec.ts --project=chromium-csp
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
# Start infrastructure (supabase local)
make dev

# Stop infrastructure
make down

# View supabase logs
make logs

# Run a migration rollback
make migrate-down
```

## Configuration

### The `.env` File

Running `make setup` creates a `.env` file with your local configuration:

```bash
# Infrastructure ports
API_PORT=8000
WEB_PORT=3000

# Application config
NEXUS_ENV=local
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres
DATABASE_URL_TEST=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test
DATABASE_URL_TEST_MIGRATIONS=postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations

# Podcast discovery/subscription provider config (S7 PR-01 / PR-02)
# make setup writes PODCASTS_ENABLED=false by default so local API boot works
# without third-party credentials.
# PODCAST_INDEX_API_KEY=<podcast-index-api-key>
# PODCAST_INDEX_API_SECRET=<podcast-index-api-secret>
# If you want podcasts enabled locally, set PODCASTS_ENABLED=true and
# provide PODCAST_INDEX_API_KEY/PODCAST_INDEX_API_SECRET.
PODCASTS_ENABLED=false

# Optional: real podcast transcription provider config (S7 PR-03)
# DEEPGRAM_API_KEY=<deepgram-api-key>
# DEEPGRAM_BASE_URL=https://api.deepgram.com
# DEEPGRAM_MODEL=nova-3
# PODCAST_TRANSCRIPTION_TIMEOUT_SECONDS=90

# Optional: scheduled active subscription polling controls (S7 PR-04)
# PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS=300
# PODCAST_ACTIVE_POLL_LIMIT=100
# PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS=900
# PODCAST_SYNC_RUNNING_LEASE_SECONDS=1800

# Supabase local configuration
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=<generated-by-supabase>
SUPABASE_SERVICE_ROLE_KEY=<generated-by-supabase>
SUPABASE_SERVICE_KEY=<same-as-SUPABASE_SERVICE_ROLE_KEY>

# Supabase auth settings (used by FastAPI)
SUPABASE_ISSUER=http://localhost:54321/auth/v1
SUPABASE_JWKS_URL=http://localhost:54321/auth/v1/.well-known/jwks.json
SUPABASE_AUDIENCES=authenticated
AUTH_ALLOWED_REDIRECT_ORIGINS=http://localhost:3000,http://localhost:3001
```

This file is:
- **Gitignored** - not committed to the repo
- **Auto-loaded** by Makefile and scripts
- **Created fresh** by each `make setup` run
- **Podcasts-off by default** for local setup until Podcast Index credentials are provided

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

#### Background Worker

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKER_POLL_INTERVAL_SECONDS` | No | Idle poll sleep in seconds (default: `2`) |
| `WORKER_SCHEDULER_INTERVAL_SECONDS` | No | Scheduler loop cadence in seconds (default: `30`) |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | No | Lease heartbeat cadence in seconds (default: `60`) |
| `WORKER_LEASE_SECONDS` | No | Default claim lease in seconds (default: `300`) |

#### Podcast Discovery + Subscription (S7 PR-01 / PR-02)

| Variable | Required | Description |
|----------|----------|-------------|
| `PODCASTS_ENABLED` | No | Feature flag for podcasts routes/jobs (default: `true`) |
| `PODCAST_INDEX_API_KEY` | If `PODCASTS_ENABLED=true` | Podcast Index API key |
| `PODCAST_INDEX_API_SECRET` | If `PODCASTS_ENABLED=true` | Podcast Index API secret |

#### Podcast Transcription (S7 PR-03)

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | For real provider transcription | Deepgram API key used for podcast transcription |
| `DEEPGRAM_BASE_URL` | No | Deepgram API base URL (default: `https://api.deepgram.com`) |
| `DEEPGRAM_MODEL` | No | Deepgram model identifier (default: `nova-3`) |
| `PODCAST_TRANSCRIPTION_TIMEOUT_SECONDS` | No | Provider request timeout in seconds (default: `90`) |

#### Podcast Active Polling (S7 PR-04)

| Variable | Required | Description |
|----------|----------|-------------|
| `PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS` | No | Worker scheduler interval for active-subscription polling (default: `300`) |
| `PODCAST_ACTIVE_POLL_LIMIT` | No | Per-run max active subscriptions scanned (default: `100`, runtime-clamped to service max) |
| `PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS` | No | Singleton poll-run lease duration in seconds (default: `900`) |
| `PODCAST_SYNC_RUNNING_LEASE_SECONDS` | No | Stale `sync_status='running'` reclaim threshold in seconds (default: `1800`) |

#### Storage (Supabase)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | For storage | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Local setup convenience | Value from `supabase status`; set `SUPABASE_SERVICE_KEY` to this value |
| `SUPABASE_SERVICE_KEY` | For storage | Supabase service role key |
| `STORAGE_BUCKET` | No | Storage bucket name (default: `media`) |
| `MAX_PDF_BYTES` | No | Max PDF upload size (default: 100 MB) |
| `MAX_EPUB_BYTES` | No | Max EPUB upload size (default: 50 MB) |
| `MAX_EPUB_ARCHIVE_ENTRIES` | No | Max ZIP entries in EPUB (default: 10000, L2 ceiling) |
| `MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES` | No | Max total uncompressed size (default: 512 MB) |
| `MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES` | No | Max single entry size (default: 64 MB) |
| `MAX_EPUB_ARCHIVE_COMPRESSION_RATIO` | No | Max compression ratio (default: 100) |
| `MAX_EPUB_ARCHIVE_PARSE_TIME_MS` | No | Max parse time in ms (default: 30000) |
| `STORAGE_TEST_PREFIX` | For tests | Test storage path prefix (e.g., `test_runs/{run_id}/`) |

#### LLM / Chat (S3+)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXUS_KEY_ENCRYPTION_KEY` | For BYOK | Base64-encoded 32-byte key for encrypting user API keys |
| `OPENAI_API_KEY` | For OpenAI | Platform API key for OpenAI models |
| `ANTHROPIC_API_KEY` | For Anthropic | Platform API key for Anthropic models |
| `GEMINI_API_KEY` | For Gemini | Platform API key for Gemini models |
| `ENABLE_STREAMING` | No | Enable SSE streaming endpoints (default: false) |
| `STREAM_TOKEN_SIGNING_KEY` | staging/prod | Base64-encoded 32-byte key for stream token JWTs |
| `STREAM_BASE_URL` | No | Public URL for /stream/* (default: http://localhost:8000) |
| `STREAM_CORS_ORIGINS` | No | Comma-separated CORS origins for /stream/* (no wildcard) |
| `STREAM_MAX_OUTPUT_TOKENS_DEFAULT` | No | Default output ceiling for budget reservation (default: 1024) |

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
| `AUTH_ALLOWED_REDIRECT_ORIGINS` | Required outside local/test | Comma-separated allowlist for callback redirect origins |
| `NEXT_PUBLIC_ENABLE_STREAMING` | No | Enable SSE streaming chat (default: `0`, set to `1` to enable) |

#### OAuth Provider Configuration

Interactive login is Google/GitHub-only. For each environment:

1. Provision Google and GitHub OAuth credentials.
2. Set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET`,
   `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID`, and
   `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_SECRET`.
3. Enable the matching provider blocks in `supabase/config.toml` for local/self-hosted Supabase.
4. Register the Supabase callback URL with the provider:
   `http://localhost:54321/auth/v1/callback` for local Supabase.
5. Register the app redirect URLs with Supabase Auth:
   `http://localhost:3000/auth/callback` and `http://localhost:3000/libraries`.
6. Optional (for live provider callback E2E coverage): set `E2E_GITHUB_USERNAME`,
   `E2E_GITHUB_PASSWORD`, and (if prompted) `E2E_GITHUB_OTP_CODE` so
   `e2e/tests/auth.spec.ts` can run the full GitHub OAuth callback round-trip
   assertion.

## Authentication

### Request Flow

1. Browser starts Google or GitHub sign-in through Supabase Auth
2. Supabase redirects back to `/auth/callback`, which exchanges the auth code for the app session
3. Next.js stores the session in cookies via `@supabase/ssr`
4. Next.js route handlers:
   - Extract access token from session (server-side only)
   - Forward to FastAPI with `Authorization: Bearer <token>`
   - Attach `X-Nexus-Internal` header
5. FastAPI validates JWT via Supabase JWKS and derives user identity
6. The first authenticated backend request bootstraps the app-local user row and default library

### Security Model

- **Tokens never in localStorage**: Access tokens exist only in server runtime
- **BFF gate**: In staging/prod, FastAPI rejects requests without internal header
- **Visibility masking**: Unauthorized access returns 404 (not 403) to hide existence
- **Supabase JWKS verification**: All environments verify JWTs via Supabase JWKS endpoint
- **Safe post-auth redirects**: Unauthenticated users are sent to `/login?next=...`; callback redirects are normalized to in-app paths only

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

### Observability (PR-09)

All backend logging uses `structlog` with JSON output and automatic context injection.

**Log context (auto-injected via ContextVars):**
- `request_id`, `user_id` — per-request identity
- `path`, `method`, `route_template` — HTTP request metadata
- `flow_id` — correlates all events in a send-message or stream flow
- `stream_jti` — stream token JTI for streaming requests

**Event taxonomy (stable dotted names):**
- `http.request.completed` / `http.request.failed` — access logs
- `llm.request.started` / `llm.request.finished` / `llm.request.failed` — LLM calls with `latency_ms`, `tokens_*`, `provider_request_id`
- `stream.started` / `stream.first_delta` / `stream.completed` / `stream.client_disconnected` — streaming lifecycle with `ttft_ms`, `chunks_count`
- `send.completed` — end-to-end send with phase timings
- `rate_limit.blocked`, `token_budget.exceeded` — throttling events
- `sweeper.orphaned_pending_finalized` — cleanup events
- `stream.jti_replay_blocked`, `stream.double_finalize_detected`, `idempotency.replay_mismatch` — invariant violations

**Redaction (security invariant):**
- `safe_kv()` guard wraps all logging keyword args
- Forbidden keys (`prompt`, `content`, `api_key`, `messages`, etc.) raise `ValueError` in dev/test, emit warning in production
- `hash_text()` for SHA-256 digests of sensitive strings
- `redact_text()` for partial masking (e.g., `sk-a***`)

### Request Tracing

Every request receives an `X-Request-ID` header for correlation and debugging:

- **Generation**: If client doesn't provide one, a UUID v4 is generated
- **Propagation**: Browser → Next.js → FastAPI → Postgres queue jobs
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

## URL Ingestion (Web + YouTube)

The system supports asynchronous URL ingestion with service-layer classification:

- **YouTube URL variants** (`watch`, `youtu.be`, `embed`, `shorts`, `live`) are normalized to one canonical provider identity and mapped to a shared `media(kind=video)` row.
- **All other URLs** follow provisional `web_article` ingestion.

### Workflow

1. **API Request**: `POST /media/from_url` with `{"url": "https://..."}`
2. **Immediate Response**: Returns `202 Accepted` with:
   - `media_id`
   - `duplicate` (compatibility flag)
   - `idempotency_outcome` (`created` or `reused`)
   - `processing_status` (current lifecycle snapshot)
   - `ingest_enqueued`
3. **Background Processing**:
   - **YouTube video path**:
     - Resolves canonical watch/embed identity from provider video id
     - Fetches transcript segments via provider boundary
     - Canonicalizes/sorts transcript segments and persists ordered fragments
     - On transcript success: sets `processing_status=ready_for_reading`
     - On transcript-unavailable terminal outcome: sets `processing_status=failed`, `last_error_code=E_TRANSCRIPT_UNAVAILABLE`, preserves playback
   - **Web article path**:
     - Fetches page via native HTTP (`fetch`, no browser JS rendering)
     - Decodes HTML using charset header/meta fallback
     - Extracts content using Mozilla Readability
     - Sanitizes HTML (XSS protection, image proxy rewriting)
     - Generates canonical text for highlighting
     - Handles deduplication by canonical URL
4. **Poll for Status**: `GET /media/{id}` returns `processing_status`

For YouTube media, `GET /media/{id}` includes a typed playback contract with provider metadata (`provider`, `provider_video_id`, canonical watch/embed URLs). Transcript-unavailable video/podcast items are excluded from transcript-driven search surfaces.

### Running the Worker

```bash
# Terminal 3: Start worker for ingestion + periodic scheduling
make worker
```

The worker requires Node.js 22+. On first run:
```bash
cd node/ingest
bun install --frozen-lockfile
```

### Ingest Reliability Guardrails

The ingest pipeline includes explicit anti-drift and recovery controls:

- **Task contract source of truth**: `python/nexus/jobs/registry.py` defines required job kinds, retry policy, lease policy, and periodic schedule metadata.
- **Startup fail-fast**: worker loads the canonical registry at startup and logs the contract fingerprint.
- **Health fingerprint**: `GET /health` includes `task_contract_version` so deploy systems can compare API and worker contract versions.
- **Auto-recovery**: worker scheduler enqueues `reconcile_stale_ingest_media_job`, which requeues stale `pdf`/`epub` rows in `extracting` and fail-closes after bounded attempts.
- **Operator controls**:
  - `POST /internal/ingest/reconcile` — manually enqueue stale-ingest reconciliation.
  - `GET /internal/ingest/reconcile/health` — inspect stale backlog count/age.

Runtime knobs:

- `INGEST_RECONCILE_SCHEDULE_SECONDS` (default `300`)
- `INGEST_STALE_EXTRACTING_SECONDS` (default `1800`)
- `INGEST_STALE_REQUEUE_MAX_ATTEMPTS` (default `3`)

### Docker Worker

```bash
# Build and run worker with docker-compose
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d worker
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

### Streaming (SSE) — PR-08 Direct Browser→FastAPI

When `ENABLE_STREAMING=true`, the frontend streams directly to FastAPI (bypassing the BFF proxy):

**Flow:**
1. Browser calls `POST /api/stream-token` (BFF, supabase cookie auth)
2. BFF proxies to `POST /internal/stream-tokens` (FastAPI mints HS256 JWT, 60s TTL)
3. Browser opens SSE: `POST {stream_base_url}/stream/conversations/{id}/messages` with `Authorization: Bearer <stream_token>`
4. FastAPI verifies stream token (iss/aud/scope/jti), streams response

**Why direct:** Vercel has a 60s function timeout and unpredictable SSE buffering. Direct connections eliminate this class of issues.

**Endpoints:**
```
POST /stream/conversations/messages         # New conversation (browser-callable)
POST /stream/conversations/{id}/messages    # Existing conversation (browser-callable)
POST /internal/stream-tokens                # Mint stream token (BFF-only)
```

**Events:** `meta` (IDs + provider info), `delta` (content chunks), `done` (final status + optional `final_chars`)

**Hardening features:**
- Keepalive pings every ~15s during idle (SSE comment `: keepalive`)
- Disconnect detection → finalize assistant as error within 5s
- Token budget pre-reservation for platform keys (prevents concurrent overspend)
- Postgres-backed liveness markers for orphan detection
- Sweeper task cleans stale pending messages (>5min, no liveness marker)
- CORS on `/stream/*` only (explicit origin allowlist, no cookies)
- Conditional finalize (exactly-once via `WHERE status='pending'`)

**Legacy endpoints (deprecated, return 410 Gone):**
```
POST /api/conversations/messages/stream
POST /api/conversations/{id}/messages/stream
```

The frontend falls back to non-streaming on stream token fetch failure.

### Frontend Chat UI

The chat UI is accessible at `/conversations`:
- **Conversation list**: sidebar with cursor pagination
- **Message thread**: paginated history (oldest first), streaming append
- **Composer**: textarea + model picker + context chips
- **Quote-to-chat**: "send to chat" button on highlight rows in the linked-items pane opens attached chat in a side pane (fallback: in-place navigation)
- **Search**: keyword search at `/search` across media, fragments, annotations, messages
- **BYOK keys**: manage API keys at `/settings/keys`

### Frontend BFF Routes (S3+S4)

| BFF Route | FastAPI Route | Method |
|-----------|---------------|--------|
| `/api/libraries/[id]/members` | `/libraries/{id}/members` | GET |
| `/api/libraries/[id]/members/[userId]` | `/libraries/{id}/members/{userId}` | PATCH, DELETE |
| `/api/libraries/[id]/transfer-ownership` | `/libraries/{id}/transfer-ownership` | POST |
| `/api/conversations` | `/conversations` | GET, POST |
| `/api/conversations/[id]` | `/conversations/{id}` | GET, DELETE |
| `/api/conversations/[id]/messages` | `/conversations/{id}/messages` | GET, POST |
| `/api/conversations/[id]/messages/stream` | ~~deprecated~~ | POST (410 Gone) |
| `/api/conversations/messages` | `/conversations/messages` | POST |
| `/api/conversations/messages/stream` | ~~deprecated~~ | POST (410 Gone) |
| `/api/stream-token` | `/internal/stream-tokens` | POST |
| `/api/me/reader-profile` | `/me/reader-profile` | GET, PATCH |
| `/api/messages/[messageId]` | `/messages/{messageId}` | DELETE |
| `/api/models` | `/models` | GET |
| `/api/keys` | `/keys` | GET, POST |
| `/api/keys/[keyId]` | `/keys/{keyId}` | DELETE |
| `/api/media` | `/media` | GET |
| `/api/media/[id]/reader-state` | `/media/{id}/reader-state` | GET, PATCH |
| `/api/search` | `/search` | GET |
| `/api/pdfjs/module` | serves `pdfjs-dist/build/pdf.mjs` (CSP-safe) | GET |
| `/api/pdfjs/worker` | serves `pdfjs-dist/build/pdf.worker.min.mjs` (CSP-safe) | GET |
| `/api/pdfjs/viewer` | serves `pdfjs-dist/web/pdf_viewer.mjs` (CSP-safe) | GET |

## API Documentation

When running locally:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Key API Endpoints

| Category | Endpoints |
|----------|-----------|
| Libraries | `GET/POST /libraries`, `PATCH/DELETE /libraries/{id}`, members, transfer-ownership (S4 PR-03) |
| Invitations | `POST/GET /libraries/{id}/invites`, `GET /libraries/invites`, accept/decline/revoke (S4 PR-04) |
| Media | `GET /media` (kind/search/cursor pagination), `GET /media/{id}`, `POST /media/from_url`, `POST /media/upload/init`, `POST /media/{id}/transcript/request` |
| EPUB Assets | `GET /media/{id}/assets/{asset_key}` (S5 PR-02: EPUB internal asset safe fetch) |
| EPUB Chapters | `GET /media/{id}/chapters`, `GET /media/{id}/chapters/{idx}` (S5 PR-04: chapter manifest + navigation) |
| EPUB Navigation | `GET /media/{id}/navigation` (canonical section targets + TOC linkage for reader UI) |
| EPUB TOC | `GET /media/{id}/toc` (legacy deterministic nested TOC tree) |
| Reader Profile | `GET/PATCH /me/reader-profile` (theme/font/line-height/column/focus/default view mode) |
| Reader Media State | `GET/PATCH /media/{id}/reader-state` (media overrides + resume locators for web/EPUB/PDF) |
| Podcasts | `GET /podcasts/discover`, `POST /podcasts/subscriptions`, `GET /podcasts/subscriptions/{podcast_id}`, `DELETE /podcasts/subscriptions/{podcast_id}?mode=1|2|3` |
| Highlights | `POST/GET /fragments/{id}/highlights`, `GET /media/{id}/highlights` (cursor-paginated, chapter-order), `PATCH/DELETE /highlights/{id}` |
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
make verify-fast       # Fast verification (static checks + unit tests)
make verify            # Full verification (lint + format + all tests)
make e2e               # Playwright E2E (auto-selects free API/WEB ports)
```

For first-time E2E setup:

```bash
cd e2e
bun install
```

Backend tests are hermetic: they start their own Postgres on free ports,
run migrations, and tear everything down. If you want to reuse existing services
instead, use `make test-back-no-services` or `make test-migrations-no-services`.
To override the hermetic test database port, set `TEST_POSTGRES_PORT`.
Hermetic test env variables are centralized in `scripts/test_env.sh`.

Supabase integration tests start and stop Supabase local by default. Set
`SUPABASE_KEEP_RUNNING=1` to keep it running after the test run.

### Test Architecture

- **Backend Integration**: Tests use `MockJwtVerifier` (test-only RSA keypair)
- **BFF Smoke Tests**: Verify header attachment and auth flow
- **Frontend Unit**: Vitest + happy-dom for component and utility tests
- **Pane Workspace Tests**: Browser-mode Vitest coverage validates URL-encoded workspace state codec, pane route resolution, workspace store reducer, SplitSurface overlay/desktop layout, shared surface chrome (SurfaceHeader, ActionMenu, Pane resize, ResponsiveToolbar priority-based overflow), and mobile UX contracts (Navbar bottom-nav + tab sheet, Pane/PageLayout hide-on-scroll chrome, WorkspaceRoot single visible group, HighlightEditPopover mobile sheet).
- **Reader Regression E2E**: Playwright `reader-resume.spec.ts` enforces settings persistence plus resume semantics across web text anchors, EPUB section locators, and PDF page+zoom locators.
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
