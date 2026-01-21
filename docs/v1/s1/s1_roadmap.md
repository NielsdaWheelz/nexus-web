# Nexus — L3 PR Roadmap: Slice 1 (Ingestion Framework + Storage)

Compressed 5-PR roadmap optimized for solo development velocity.

**Assumptions:**
- S0 complete: auth, libraries, memberships, BFF proxy (`proxyToFastAPI()`), UI shell exist
- Monorepo: Next.js + FastAPI + Celery workers
- DB: PostgreSQL 15+ with pgvector, SQLAlchemy 2.x (sync), Alembic
- Internal header required in **all envs** (value differs: `dev-secret` in local/test)

---

## PR-01 — Scaffold + Infra + Migrations + Test Harness

**Goal:** Repo boots; DB schema exists; tests run deterministically.

**Deliverables:**

- Monorepo skeleton:
  ```
  apps/web/         # Next.js (from S0)
  apps/api/         # FastAPI
  apps/worker/      # Celery
  packages/shared/  # Shared Python (optional)
  infra/            # Compose, scripts
  ```
- `docker-compose.yml`:
  - `postgres:15` with pgvector
  - `redis:7`
- `Makefile` / `justfile`:
  - `make dev` — starts infra
  - `make test` — runs pytest
  - `make migrate` — runs alembic
- `.env.example` with scoping:
  ```
  # === All apps ===
  NEXUS_ENV=local
  NEXUS_INTERNAL_SECRET=dev-secret

  # === API + Worker only ===
  DATABASE_URL=...
  SUPABASE_SERVICE_ROLE_KEY=...  # NEVER in web

  # === Web only ===
  NEXT_PUBLIC_SUPABASE_URL=...
  NEXT_PUBLIC_SUPABASE_ANON_KEY=...
  FASTAPI_BASE_URL=...
  ```
- CI workflow (GitHub Actions):
  - Start postgres + redis
  - Run migrations
  - Run pytest (storage tests require secrets, fail if missing)
  - Internal header secret set in CI
- Alembic init + first migration:
  - `media` table (all S1 fields: kind, processing_status, failure_stage, timestamps, attempts, urls, file_sha256, provider/provider_id)
  - `media_file` table
  - `fragment` table (empty in S1)
  - Partial unique indexes per S1 spec
- ORM models: `Media`, `MediaFile`, `Fragment`
- pytest harness:
  - Single Engine/Connection for test session
  - Outer transaction + SAVEPOINT per test
  - Session injected into FastAPI deps via `get_db_session()`
  - Event listener to restart SAVEPOINT after commits
  - Guardrail: forbid Engine creation outside DI (monkeypatch/lint)
  - **Test client fixture auto-includes internal header** (baked in, can't forget)
- One proof test: create row, verify gone after rollback

**Why merge:** These pieces are mutually dependent; splitting is fake neatness.

**Tests:**
- Migration applies to empty DB
- Schema constraints work (unique indexes)
- Rollback isolation proof

---

## PR-02 — FastAPI Bootstrap + Middleware + Auth + Error Envelope

**Goal:** One protected endpoint works; request pipeline is locked.

**Deliverables:**

- FastAPI app factory in `apps/api`
- Middleware stack:
  - `X-Request-ID`: generate if missing, echo on response, add to logs
  - `X-Nexus-Internal`: required in ALL envs (constant-time compare)
  - Supabase JWT verification via JWKS (cached with TTL)
  - Derive `viewer_user_id` from `sub`
- Error envelope:
  ```json
  { "error": { "code": "E_...", "message": "..." } }
  ```
- Success envelope:
  ```json
  { "data": ... }
  ```
- `GET /whoami` endpoint (returns viewer info)
- Structured logging with request_id

**Tests:**
- Missing token → 401
- Invalid token → 401
- Missing internal header → 403
- Request ID generated/echoed

**Note:** Next.js forwarding of `X-Request-ID` is in PR-04 (BFF concern).

---

## PR-03 — Authorization + Media Endpoints + Capability Derivation

**Goal:** Fetch media safely; never leak; capabilities derived correctly.

**Deliverables:**

- Authorization module:
  ```python
  can_read_media(viewer_user_id, media_id) -> bool
  is_library_admin(viewer_user_id, library_id) -> bool
  is_admin_of_any_containing_library(viewer_user_id, media_id) -> bool
  ```
- Enums: `ProcessingStatus`, `FailureStage`
- Pure function:
  ```python
  derive_capabilities(media, media_file_exists, external_playback_url_exists) -> dict
  ```
  - Handles `failed + E_TRANSCRIPT_UNAVAILABLE` playback-only
  - Handles PDF can_read before ready_for_reading
- Endpoints:
  - `GET /media/{id}` — returns media + processing_status + capabilities, 404 if cannot read
  - `GET /media` — list readable media only
- Minimal seed fixtures in tests (libraries, memberships, media rows)

**Tests:**
- Visibility masking: non-member gets 404
- Capability matrix unit tests (all kinds, key statuses, edge cases)
- Member sees media, non-member doesn't

**Note:** No upload, retry, or Celery yet.

---

## PR-04 — Storage + Upload + Ingest + File Idempotency + Upload UI

**Goal:** File uploads work end-to-end (API + UI) and are secure.

### API Deliverables

- `StorageClient` abstraction:
  ```python
  sign_download(path, expires_in_s)
  sign_upload(path, expires_in_s, content_type)
  delete_object(path)
  object_exists(path)
  stream_object(path) -> bytes iterator
  ```
- `GET /media/{id}/file`:
  - `can_read_media` check → 404 if fails
  - Requires `media_file` exists
  - Returns signed URL (5 min expiry)
- `POST /media/upload/init`:
  - Validates `kind ∈ {pdf, epub}`
  - Validates content-type (`application/pdf`, `application/epub+zip`)
  - Validates size (`MAX_PDF_BYTES=100MB`, `MAX_EPUB_BYTES=50MB`)
  - Creates media row (pending) + media_file
  - Returns signed upload URL + headers + expiry
- `POST /media/{id}/ingest`:
  - Verifies object exists in storage
  - Streams object, computes sha256
  - Sets `media.file_sha256`
  - Enforces `(created_by_user_id, kind, file_sha256)` uniqueness:
    - Duplicate → delete new upload, return existing media_id
  - Enqueues ingestion job (stub; real tasks in PR-05)
- Test storage prefix: `test_runs/{run_id}/...` with cleanup

### Web Deliverables

- Extend `proxyToFastAPI()` to forward/generate `X-Request-ID`:
  - Generate UUID if not present
  - Forward to FastAPI
  - (Optional) Return FastAPI's response header to browser
- BFF routes (follow S0 route mirroring pattern):
  - `POST /api/media/upload/init` → proxies to `POST /media/upload/init`
  - `POST /api/media/[id]/ingest` → proxies to `POST /media/{id}/ingest`
  - `GET /api/media/[id]/file` → proxies to `GET /media/{id}/file`
- Upload flow UI (minimal, uses S0 shell):
  - File picker (accepts pdf/epub only)
  - Call `/api/media/upload/init` → get signed URL
  - PUT file to signed upload URL
  - Call `/api/media/{id}/ingest`
  - Show progress/error states
- `ProcessingStatusBadge` component:
  - Reads `processing_status` from `GET /media/{id}` response
  - Displays pending/extracting/failed/ready states

**Why UI here:** This is the first PR where S1 introduces user-triggered upload. Shipping upload without UI is wasted time for solo dev.

**Tests:**
- Member gets signed URL; non-member gets 404
- Upload init returns path/url/expiry
- Ingest computes sha256
- Same file + same user → dedupe
- Same file + different user → separate rows
- Size/content-type validation → 400
- No Next.js-specific tests; API tests provide correctness; manual smoke for upload UI

---

## PR-05 — State Machine + Retry/Reset + Celery + URL Idempotency + Retry UI

**Goal:** Jobs are real; retries are deterministic; invariants enforced; URL media works.

### API Deliverables

- Service-layer state transitions:
  ```python
  transition(media_id, to_status, *, failure_stage?, error_code?, error_message?)
  mark_failed(media_id, stage, error_code, error_message)
  retry_media(media_id, actor_user_id)
  ```
- `retry_media` authorization: creator OR admin of any containing library
- Reset rules per `failure_stage` (deletes dependent rows)
- `POST /media/{id}/retry` endpoint
- URL canonicalization:
  ```python
  canonicalize_url(requested_url) -> canonical_url
  # lowercase scheme+host, drop fragments, strip utm_*/gclid/fbclid
  ```
- `POST /media/url` endpoint:
  ```json
  Request: { "kind": "web_article", "url": "..." }
  Response: { "data": { "media_id": "...", "created": true|false } }
  ```
  - Idempotent by `(kind, canonical_url)`
  - Reuses failed rows
- Celery worker skeleton (`apps/worker`):
  - Broker/Redis config via env
  - Eager mode toggle for tests
  - `ingest_media(media_id, request_id?)`:
    - `pending → extracting → failed` with `E_EXTRACTOR_NOT_IMPLEMENTED`
    - (Real extractors in S2+)
  - Auto retry policy: max 3 for transient codes
- Processing-state integration test suite:
  - Deterministic transitions
  - Retry clears failure fields
  - Playback-only semantics (`failed + E_TRANSCRIPT_UNAVAILABLE`)
  - URL + file idempotency
  - Signed URL security
  - Documentation: "how to extend for new media kinds"

### Web Deliverables

- BFF route:
  - `POST /api/media/[id]/retry` → proxies to `POST /media/{id}/retry`
- Retry button in UI:
  - Visible when `processing_status = failed`
  - Calls `/api/media/{id}/retry`
  - Refreshes status afterwards
- `ProcessingStatusBadge` behavior for failed states (optional: special copy/styling)

**Why UI here:** Retry UI depends on retry endpoint and semantics. Don't ship a button that lies.

**Tests:**
- Eager-mode Celery: enqueue → extracting → failed
- Retry clears state, re-enqueues
- URL canonicalization unit tests
- URL idempotency: same URL → same media_id
- Processing-state suite runs in CI
- No Next.js-specific tests; API tests provide correctness

---

## Dependency Order

```
PR-01 → PR-02 → PR-03 → PR-04 → PR-05
         (linear, no parallelization needed for solo dev)
```

---

## Global Constraints

- **No fake extractors:** S1 jobs must not create fragments
- **Internal header required everywhere:** test client fixture bakes it in
- **UI must use `capabilities`**, not raw statuses
- **Tests run against real Postgres** with nested transaction isolation
- **Storage tests use `test_runs/{run_id}/...` prefix** and clean up
- **No Next.js-specific tests in S1:** API integration tests + manual smoke for UI
