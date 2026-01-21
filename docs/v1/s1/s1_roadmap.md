# Nexus — L3 PR Roadmap: Slice 1 (Ingestion Framework + Storage)

Compressed 5-PR roadmap that **extends S0** (not duplicates it).

> **Prerequisite:** S0 (PRs 01–05) must be merged before S1 begins. See `docs/v1/s0/s0_roadmap.md` for the S0 PR sequence.

**What S0 Already Provides:**
- FastAPI app bootstrap + error/success envelope
- Alembic setup + base tables (`users`, `libraries`, `memberships`, `media`, `fragments`, `library_media`)
- Auth middleware + JWKS verification + internal header enforcement
- DB session helpers + test harness (nested transactions, rollback isolation)
- `proxyToFastAPI()` BFF helper with bearer token + internal header
- UI shell (navbar, tabsbar, panes)
- `GET /media/{id}`, `GET /media/{id}/fragments` endpoints
- Visibility via library membership (but not as reusable predicates)

**What S1 Adds:**
- Redis + Celery worker infrastructure
- `media` table S1 fields (processing_status, failure_stage, timestamps, file_sha256, canonical_url, external_playback_url, etc.)
- `media_file` table
- `X-Request-ID` middleware + BFF propagation + Celery logging
- Reusable authorization predicates (`can_read_media`, etc.)
- Capability derivation (viewer-scoped)
- Storage client + upload/download endpoints
- State machine + retry semantics
- URL canonicalization + idempotency (string-only; no redirect resolution)
- Processing-state test suite
- CI workflow

---

## Writer Responsibility Model

**Worker owns:**
- All `processing_status` transitions (including `pending → extracting`)
- `processing_attempts`, `processing_started_at`, `processing_completed_at`, `failed_at`
- `failure_stage`, `last_error_code`, `last_error_message`

**API owns:**
- Identity fields: `requested_url`, `canonical_url`, `file_sha256`
- Storage metadata: `media_file` rows
- Initial state: create media with `processing_status = pending`
- Manual retry: reset `processing_status = pending`, clear failure fields, re-enqueue

**Invariant:** Only one codepath writes each field category. No mixing.

---

## Internal Header Enforcement Policy

| Environment | Header Required | Secret Value |
|-------------|-----------------|--------------|
| `local` | Yes | `local-dev-secret` (default in `.env.example`) |
| `test` | Yes | `test-secret` (hardcoded in test fixtures) |
| `staging` | Yes | Must be set via env (fail fast if missing) |
| `prod` | Yes | Must be set via env (fail fast if missing) |

**Rationale:** Header is always required; only the secret value differs. Prevents "works locally without header" bugs.

---

## PR-01 — Infra (Redis + Celery) + S1 Migration + CI

**Goal:** Add Celery infrastructure; extend schema for S1; establish CI.

**Deliverables:**

- Add to `docker-compose.yml`:
  - `redis:7` service
  - `postgres:15` service (explicit; S0 may have external postgres, but compose should be self-contained for CI)
- Add `apps/worker/` directory:
  - Celery app config (broker via env)
  - Empty task module (tasks added in PR-05)
- Extend `Makefile` / `justfile`:
  - `make worker` — starts Celery worker
- Extend `.env.example`:
  - `REDIS_URL`
  - `CELERY_BROKER_URL`
  - `NEXUS_INTERNAL_SECRET=local-dev-secret` (default for local/test)
- Alembic migration to **add S1 fields to existing `media` table**:
  - `processing_status` (enum, default `pending`)
  - `failure_stage` (enum, nullable)
  - `last_error_code`, `last_error_message` (nullable)
  - `processing_attempts` (int, default 0)
  - `processing_started_at`, `processing_completed_at`, `failed_at` (nullable timestamps)
  - `file_sha256` (nullable, for pdf/epub)
  - `requested_url` (text, nullable)
  - `canonical_url` (text, nullable)
  - `external_playback_url` (text, nullable) — for podcasts/videos; needed for capability derivation
  - `provider`, `provider_id` (nullable, for future S7/S8)
- Alembic migration to **create `media_file` table**:
  - `media_id` (pk, fk)
  - `storage_path`, `content_type`, `size_bytes`
- Add partial unique indexes per S1 spec:
  - `(kind, canonical_url)` where `canonical_url` is not null
  - `(created_by_user_id, kind, file_sha256)` where kind in (pdf, epub) and `file_sha256` is not null
- **Enum strategy:** Use Postgres `CREATE TYPE` for enums; Alembic migrations must handle create/drop cleanly (use `op.execute` for `CREATE TYPE IF NOT EXISTS`)
- Extend ORM models: add new fields to `Media`, create `MediaFile`
- Extend test client fixture: **auto-include internal header** with test secret
- **`updated_at` policy:** Service functions must set `updated_at` on state changes (no DB triggers)
- Add `.github/workflows/ci.yml`:
  - Lint + typecheck (ruff, pyright optional)
  - `pytest` (unit + integration)
  - Start docker-compose services (postgres, redis)
  - Set env vars from secrets
  - Storage integration tests: conditional (see §Storage Test Playbook)

**Tests:**
- Migration applies cleanly on top of S0 schema
- New constraints work (unique indexes)
- Celery app initializes (smoke test)
- CI runs green

---

## PR-02 — X-Request-ID Middleware + Authorization Predicates

**Goal:** Add request tracing (API + BFF + Celery); create reusable visibility predicates.

**Deliverables:**

- Add `X-Request-ID` middleware to existing FastAPI app:
  - Generate UUID if not present in request
  - Echo on response header
  - Add to structured logs (JSON format, minimal)
- **Extend `proxyToFastAPI()` to forward/generate `X-Request-ID`:**
  - Generate UUID if not present in BFF request
  - Forward to FastAPI in outbound request
- **Celery convention:**
  - Tasks accept optional `request_id` parameter
  - All task log entries include `request_id`
  - When FastAPI enqueues a task, it passes `request_id` from middleware context
- **Structured logging:** JSON format for FastAPI + Celery, with `request_id`, `user_id`, `timestamp` fields
- Authorization module (`app/auth/permissions.py` or similar):
  ```python
  can_read_media(viewer_user_id: UUID, media_id: UUID) -> bool
  # True iff media is in at least one library the viewer is a member of

  can_read_media_bulk(viewer_user_id: UUID, media_ids: list[UUID]) -> dict[UUID, bool]
  # Efficient batch check for list endpoints

  is_library_admin(viewer_user_id: UUID, library_id: UUID) -> bool
  # True iff viewer has admin role in library

  is_admin_of_any_containing_library(viewer_user_id: UUID, media_id: UUID) -> bool
  # True iff viewer is admin of any library containing the media
  ```
- Refactor existing `GET /media/{id}` to use `can_read_media` predicate (currently inline)
- Single source of truth for visibility logic

**Tests:**
- Request ID generated when missing (FastAPI)
- Request ID echoed when provided (FastAPI)
- Request ID forwarded by BFF
- Request ID appears in Celery task logs
- `can_read_media`: member returns true, non-member returns false
- `can_read_media_bulk`: correct for mixed visibility
- `is_library_admin`: correct role check
- Existing media endpoint tests still pass (refactor doesn't break behavior)

---

## PR-03 — Processing Status + Capability Derivation + Media List

**Goal:** Add state machine enums; implement viewer-scoped capability derivation; add media list endpoint.

**Deliverables:**

- Enums (in ORM or separate module):
  - `ProcessingStatus`: `pending`, `extracting`, `ready_for_reading`, `embedding`, `ready`, `failed`
  - `FailureStage`: `upload`, `extract`, `transcribe`, `embed`, `other`
- Pure function with **viewer-scoped** signature:
  ```python
  derive_capabilities(
      media,
      *,
      viewer_can_read: bool,
      media_file_exists: bool,
      external_playback_url_exists: bool
  ) -> dict
  ```
  - Returns: `can_read`, `can_highlight`, `can_quote`, `can_search`, `can_play`, `can_download_file`
  - **If `viewer_can_read` is false, all capabilities are false** (endpoint returns 404 anyway)
  - Handles `failed + E_TRANSCRIPT_UNAVAILABLE` → playback-only
  - **PDF special case:** `can_read` = `media_file_exists AND viewer_can_read`, independent of `processing_status`
    - `ready_for_reading` for PDF means "text extraction complete" (enables `can_quote`, `can_search`)
    - Viewing (pdf.js render) is available earlier if file exists
- **State invariant clarification:**
  - `ready_for_reading` means "highlightable/quotable artifacts exist for that kind"
  - For PDF: file renderability (`can_read`) can happen before `ready_for_reading`
  - For web_article/epub: `can_read` requires `ready_for_reading` (fragments exist)
- Extend `GET /media/{id}` response to include:
  - `processing_status`
  - `failure_stage`, `last_error_code` (if failed)
  - `capabilities` object (nested in `data`)
- Add `GET /media` list endpoint:
  - Returns media in viewer's default library (most common use case)
  - Cursor pagination (keyset on `created_at`, `id`)
  - Each item includes `capabilities` (use `can_read_media_bulk` for efficiency)
  - Response: `{ "data": { "items": [...], "next_cursor": "..." } }`

**Response envelope contract:**
```json
{
  "data": {
    "id": "...",
    "kind": "pdf",
    "processing_status": "pending",
    "capabilities": { "can_read": true, ... },
    ...
  }
}
```
Never leak raw DB fields; capabilities always nested in response.

**Tests:**
- Capability matrix unit tests (all kinds × key statuses × viewer_can_read true/false)
- Playback-only edge case (`failed + E_TRANSCRIPT_UNAVAILABLE`)
- PDF special case: `can_read = true` with file before `ready_for_reading`
- PDF: `can_read = false` if `viewer_can_read = false` regardless of file existence
- PDF: `can_quote = false` before `ready_for_reading`, `can_quote = true` after
- API responses include capabilities
- `GET /media` returns paginated list with capabilities

---

## PR-04 — Storage + Upload + Ingest + File Idempotency + Upload UI

**Goal:** File uploads work end-to-end (API + UI) and are secure.

### API Deliverables

- `StorageClient` abstraction (`app/storage/client.py`):
  ```python
  sign_download(path, expires_in_s) -> str
  sign_upload(path, expires_in_s, content_type) -> SignedUpload
  # SignedUpload: { url: str, headers: dict }
  # Returns presigned PUT URL (Supabase Storage)
  delete_object(path)
  object_exists(path) -> bool
  get_object_metadata(path) -> ObjectMetadata | None
  # ObjectMetadata: { content_type: str, size_bytes: int }
  stream_object(path) -> Iterator[bytes]
  ```
- **Storage path prefix config:** `app/storage/config.py` with `get_storage_prefix()` that returns:
  - Production: `media/`
  - Test: `test_runs/{run_id}/media/` (from env or fixture)
- `GET /media/{id}/file`:
  - `can_read_media` check → 404 if fails
  - Requires `media_file` exists
  - Returns `{ "url": "...", "expires_at": "..." }` (5 min expiry)
- `POST /media/upload/init`:
  - Validates `kind ∈ {pdf, epub}`
  - Validates content-type (`application/pdf`, `application/epub+zip`)
  - Validates size (`MAX_PDF_BYTES=100MB`, `MAX_EPUB_BYTES=50MB`)
  - Creates media row (`processing_status = pending`) + media_file row
  - **Creates `library_media` row in viewer's default library** (creator must be able to read their own media)
  - Returns signed upload URL + headers + expiry
- `POST /media/{id}/ingest`:
  - Verifies caller is media creator
  - Verifies object exists in storage via `get_object_metadata`
  - **Validates content-type matches expected** (HEAD check)
  - Streams object, computes sha256
  - Sets `media.file_sha256`
  - **Duplicate handling (race-safe):**
    - Attempt to set `file_sha256` in transaction
    - If unique constraint violation: fetch existing media_id, delete uploaded object, return existing media_id as duplicate
    - Response: `{ "data": { "media_id": "...", "duplicate": true|false } }`
  - If not duplicate: **enqueue `ingest_media` task** (status remains `pending`; worker transitions)
- **No re-upload to same media_id:** Each upload init creates fresh media_id; duplicates collapse via sha256

### Web Deliverables

- Add BFF routes (follow S0 mirroring pattern):
  - `POST /api/media/upload/init` → `POST /media/upload/init`
  - `POST /api/media/[id]/ingest` → `POST /media/{id}/ingest`
  - `GET /api/media/[id]/file` → `GET /media/{id}/file`
- Upload flow UI:
  - File picker (accepts pdf/epub)
  - Call upload init → get signed URL
  - PUT file to signed URL
  - Call ingest
  - Show progress/error states
  - Handle duplicate response (show link to existing media)
- `ProcessingStatusBadge` component

**Tests:**
- Member gets signed URL; non-member gets 404
- Upload init creates library_media in default library
- Upload init returns path/url/expiry
- Ingest validates content-type matches
- Ingest computes sha256
- Same file + same user → dedupe (race-safe)
- Same file + different user → separate rows
- Size/content-type validation → 400
- Manual smoke for upload UI

---

## PR-05 — State Machine + Retry + Celery Tasks + URL Idempotency + Retry UI

**Goal:** Jobs are real; retries are deterministic; URL media works.

### API Deliverables

- **Lifecycle service functions** (`app/services/media_lifecycle.py`):
  ```python
  def worker_start_attempt(media_id: UUID) -> None:
      """Called by worker at job start. Single writer for these fields."""
      # Assert status == pending
      # Increment processing_attempts
      # Set processing_started_at = now
      # Set processing_status = extracting
      # Set updated_at = now

  def mark_ready_for_reading(media_id: UUID) -> None:
      # Assert status == extracting
      # Set processing_status = ready_for_reading
      # Set updated_at = now

  def mark_failed(media_id: UUID, stage: FailureStage, error_code: str, error_message: str) -> None:
      # Set processing_status = failed
      # Set failure_stage, last_error_code, last_error_message
      # Set failed_at = now
      # Set updated_at = now

  def retry_media(media_id: UUID, actor_user_id: UUID) -> None:
      """API-callable. Resets state and re-enqueues."""
      # Verify actor is creator OR is_admin_of_any_containing_library
      # Apply reset rules per failure_stage (delete dependent rows)
      # Set processing_status = pending
      # Clear failure_stage, last_error_code, last_error_message, failed_at
      # Clear processing_started_at
      # Set updated_at = now
      # Enqueue ingest_media task
  ```
- `POST /media/{id}/retry` endpoint
- URL canonicalization (`app/services/url.py`):
  ```python
  canonicalize_url(requested_url: str) -> str
  # Lowercase scheme+host, drop fragments, strip utm_*/gclid/fbclid
  # NO redirect resolution (that's extractor responsibility in S2+)
  ```
- `POST /media/url` endpoint:
  - Request: `{ "kind": "web_article", "url": "..." }`
  - Response: `{ "data": { "media_id": "...", "created": true|false } }`
  - Canonicalizes URL, checks `(kind, canonical_url)` uniqueness
  - Reuses existing rows (including failed ones)
  - **Creates `library_media` row in viewer's default library**
  - **Does NOT enqueue task in S1** — media stays `pending` with no worker action
    - Rationale: S1 has no extractors; enqueueing would instantly fail with `E_EXTRACTOR_NOT_IMPLEMENTED`
    - UI shows "Queued" badge; actual processing starts when extractor slice lands
- Celery tasks (`apps/worker/tasks.py`):
  - `ingest_media(media_id: UUID, request_id: str | None = None)`:
    - Calls `worker_start_attempt(media_id)` → `pending → extracting`
    - Checks `media.kind`
    - For `pdf`/`epub`: succeeds (file already exists; in S1, just mark complete or leave extracting)
    - For URL kinds: `mark_failed(media_id, "extract", "E_EXTRACTOR_NOT_IMPLEMENTED", "...")`
    - (Real extractors in S2+)
  - Auto retry: max 3 for transient error codes only
  - Eager mode toggle for tests
- **Error code taxonomy** (`app/services/errors.py`):
  ```python
  # Internal error codes (stored in last_error_code)
  TRANSIENT_ERRORS = {"E_NETWORK_ERROR", "E_TIMEOUT", "E_PROVIDER_5XX"}
  PERMANENT_ERRORS = {"E_EXTRACTOR_NOT_IMPLEMENTED", "E_INVALID_CONTENT", "E_CONTENT_TOO_LARGE"}

  def is_transient_error(error_code: str) -> bool:
      return error_code in TRANSIENT_ERRORS

  # API error codes (returned to clients) are mapped separately in app/errors.py
  ```
- **State invariant:** `extracting` means "a worker attempt started" (set by `worker_start_attempt`)

### Processing-State Integration Test Suite

**Scope:** FastAPI + DB + Redis + storage only (no Next.js in Python tests)

**Coverage:**
- Deterministic state transitions
- `worker_start_attempt` increments attempts, sets timestamps
- Retry clears failure fields, re-enqueues
- Playback-only semantics (`failed + E_TRANSCRIPT_UNAVAILABLE`)
- URL idempotency: same URL → same media_id
- File idempotency: same file + same user → dedupe
- Documentation: "how to extend for new media kinds"

### Web Deliverables

- Add BFF routes:
  - `POST /api/media/[id]/retry` → `POST /media/{id}/retry`
  - `POST /api/media/url` → `POST /media/url`
- Retry button in UI:
  - Visible when `processing_status = failed`
  - Calls retry endpoint
  - Refreshes status
- URL media creation UI (if desired; can defer to S2)

**Tests:**
- Eager-mode Celery: file upload → ingest → extracting (stays extracting in S1 for pdf)
- URL media stays `pending` (no task enqueued in S1)
- Worker increments `processing_attempts` on start
- Retry clears state, re-enqueues
- `is_transient_error` unit tests
- URL canonicalization unit tests
- URL idempotency: same URL → same media_id
- Processing-state suite runs in CI

---

## Dependency Order

```
PR-01 → PR-02 → PR-03 → PR-04 → PR-05
```

---

## Storage Test Playbook

**Marker:** `@pytest.mark.storage` for tests requiring Supabase Storage

**CI configuration:**
```yaml
- name: Run storage tests
  if: ${{ secrets.SUPABASE_URL != '' }}
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
    STORAGE_TEST_PREFIX: test_runs/${{ github.run_id }}/
  run: pytest -m storage
```

**Required secrets:**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

**Local development:** Tests skip if secrets missing (not fail)

**Cleanup:** Test teardown deletes `test_runs/{run_id}/` prefix; CI cleanup job removes stale prefixes (>24h)

---

## Global Constraints

- **No fake extractors:** S1 jobs must not create fragments
- **Internal header required everywhere:** See §Internal Header Enforcement Policy
- **UI must use `capabilities`**, not raw statuses
- **Extend, don't duplicate:** S0 provides the foundation; S1 adds to it
- **Storage tests use `test_runs/{run_id}/...` prefix** and clean up
- **Writer responsibility model:** See §Writer Responsibility Model
- **Service layer owns `updated_at`:** No DB triggers; lifecycle functions set `updated_at`
- **Processing-state tests are Python-only:** FastAPI + DB + Redis + storage; Next.js tested separately via Playwright/e2e
- **Creators can read their media:** Upload init and URL creation must add `library_media` to default library

---

## Endpoint Naming Note

S1 uses separate endpoints for different creation flows:
- `POST /media/url` — create URL-based media (web_article, video, podcast)
- `POST /media/upload/init` — initiate file upload (pdf, epub)

Both share idempotency logic via common service functions and both add media to the creator's default library.

---

## URL Media Behavior in S1

Since S1 has no extractors, URL-based media (`POST /media/url`) behaves as follows:
- Media row created with `processing_status = pending`
- Added to creator's default library (visible, but not readable)
- **No task enqueued** — avoids instant failure noise
- UI shows "Queued" or "Awaiting Processor" badge
- When S2 lands (web article extractor), existing `pending` URL media can be manually retried or batch-processed

This is intentional: S1 establishes the framework; S2+ provides the extractors.
