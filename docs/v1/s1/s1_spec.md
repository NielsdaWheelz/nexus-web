# Nexus — L2 Slice Spec: S1 Ingestion Framework + Storage

This spec defines the ingestion framework, storage model, processing state machine, retry semantics, idempotency, and API contracts required before any media-specific extraction logic is implemented.

This slice introduces no real extractors. It exists to make ingestion *structural*, *testable*, and *irreversible*.

---

## 1) Purpose

Establish a deterministic, testable ingestion framework that:
- enforces the global media lifecycle
- guarantees immutability boundaries
- supports retries without partial-state corruption
- provides secure file storage and access
- exposes stable API contracts for all future media kinds

All later slices (S2–S9) depend on S1 invariants.

---

## 2) In Scope

- Media lifecycle state machine
- Job orchestration skeleton (Celery + Redis)
- Inline ingestion path for dev
- File upload + storage (Supabase Storage)
- Idempotency rules (URL + file)
- Retry/reset semantics
- Capability derivation
- Quota enforcement hooks (no real limits yet)
- Processing-state test suite

---

## 3) Out of Scope

- Any real extraction logic (HTML, EPUB, PDF, transcript)
- Highlighting
- Search
- Conversations
- Sharing
- Billing enforcement (limits only stubbed)

---

## 4) Data Model (Minimum)

### `media`
Core ingestion unit.

Required fields:
- `id` (uuid, pk)
- `kind` (enum)
- `processing_status` (enum)
- `failure_stage` (enum|null)
- `last_error_code` (string|null)
- `last_error_message` (text|null)
- `processing_attempts` (int, default 0)
- `processing_started_at` (timestamptz|null)
- `processing_completed_at` (timestamptz|null)
- `failed_at` (timestamptz|null)
- `requested_url` (text|null)
- `canonical_url` (text|null)
- `file_sha256` (text|null) — for pdf/epub only; null for url-based media
- `provider` (text|null) — e.g., "youtube"; for future S7/S8 identity keys
- `provider_id` (text|null) — e.g., video ID; for future S7/S8 identity keys
- `created_by_user_id` (uuid)
- `created_at`, `updated_at`

**Timestamp + Attempt Semantics:**
- `processing_attempts` increments each time a job attempt starts (including automatic retries)
- `processing_attempts` is NOT reset on success; it tracks total attempts
- `processing_started_at` is set when `pending → extracting`; cleared on retry
- `processing_completed_at` is set when reaching `ready` or `ready_for_reading`
- `failed_at` is set when entering `failed` state; cleared on retry

Constraints:
- `(kind, canonical_url)` unique where `canonical_url` is not null — for url-based media
- `(created_by_user_id, kind, file_sha256)` unique where `kind in ('pdf', 'epub')` and `file_sha256` is not null — for file uploads
- media rows are immutable in identity; retries reuse the same row

---

### `media_file`
0..1 per media. Stores file storage metadata (not used for idempotency).

Fields:
- `media_id` (pk, fk)
- `storage_path` (text)
- `content_type` (text)
- `size_bytes` (int)

Note: `sha256` lives on `media.file_sha256` for constraint enforcement; `media_file` is purely storage metadata.

---

### `fragment`
Exists but remains empty in S1.
- Table is created; no rows are written by S1 jobs.
- `ready_for_reading` is not reachable via S1 ingestion (no extractors exist).
- S1 tests use seeded fixture media (from S0) for `ready_for_reading` scenarios.

---

## 5) Processing State Machine

### States

```
pending → extracting → ready_for_reading → embedding → ready
    ↘           ↘              ↘               ↘
                            failed
```

### State Invariants

| State | Guaranteed True |
|-------|-----------------|
| `pending` | Media row exists; awaiting job pickup |
| `extracting` | Extraction requested and in-flight or queued |
| `ready_for_reading` | Minimum readable artifacts exist (per-kind; see §6) |
| `embedding` | Readable; embedding job in-flight or queued |
| `ready` | Embedding complete |
| `failed` | Terminal failure recorded; `failure_stage` + `last_error_code` set |

**S1 Limitations:**
- S1 creates no real artifacts; `ready_for_reading` is unreachable via S1 jobs.
- S1 tests focus on: `pending → extracting → failed`, `failed → retry`, and storage signing.
- `ready_for_reading` tests use seeded fixture media from S0.
- `extracting` means "job requested," not "job actively running" (worker crash doesn't violate the invariant).

---

## 6) Capabilities Derivation (Hard Contract)

A derived object is returned by all `GET /media/*` endpoints:

```python
capabilities = {
    "can_read": bool,           # can render primary content pane
    "can_highlight": bool,      # can create highlights
    "can_quote": bool,          # can quote-to-chat
    "can_search": bool,         # included in search results
    "can_play": bool,           # has playable external url
    "can_download_file": bool,  # can download original file
}
```

Derived **only** from:
- `media.kind`
- `processing_status`
- `last_error_code`
- `media_file` existence (for `can_download_file`)
- `external_playback_url` existence (for `can_play`)

### Capability Rules by Kind

**All kinds:**
- `can_download_file` = true iff `media_file` exists AND `can_read(viewer, media)` passes
- `can_play` = true iff `external_playback_url` exists AND (`status >= ready_for_reading` OR `failed + E_TRANSCRIPT_UNAVAILABLE`)

**web_article / epub:**
- `can_read` = true iff `status >= ready_for_reading` (fragments exist)
- `can_highlight` = `can_read`
- `can_quote` = `can_read`
- `can_search` = `can_read`

**pdf:**
- `can_read` = true iff `media_file` exists AND pdf.js can render (even before text extraction completes)
- `can_highlight` = `can_read` (geometry-based)
- `can_quote` = `can_read` AND `media.plain_text` exists (may be delayed until text extraction completes)
- `can_search` = `can_quote`
- Note: pdf allows viewing before `ready_for_reading` if file is stored and renderable

**podcast_episode / video:**
- `can_read` = true iff transcript fragments exist (`status >= ready_for_reading`)
- `can_highlight` = `can_read`
- `can_quote` = `can_read`
- `can_search` = `can_read`
- `can_play` = true iff `external_playback_url` exists (even if `failed + E_TRANSCRIPT_UNAVAILABLE`)
- Special case: `failed + E_TRANSCRIPT_UNAVAILABLE` → `can_play=true`, `can_read=false`, `can_highlight=false`

### S1 Baseline Rules

S1 implements the capability derivation logic but:
- Only `pdf`/`epub` have `media_file` scenarios (file upload flow)
- No fragments exist (no extractors), so `can_read` is always false for S1-created media
- `ready_for_reading` capability tests use seeded S0 fixtures
- `failed + E_TRANSCRIPT_UNAVAILABLE` semantics are testable via state injection

UI and downstream slices must rely on capabilities, never raw status.

---

## 7) Failure Taxonomy

### `failure_stage` Enum

```
upload | extract | transcribe | embed | other
```

### Internal `last_error_code`

Examples (non-exhaustive):
- `E_UPLOAD_FAILED`
- `E_EXTRACTION_FAILED`
- `E_TRANSCRIPT_UNAVAILABLE`
- `E_JOB_TIMEOUT`
- `E_EMBEDDING_FAILED`

Internal codes may change; API error codes are mapped separately.

---

## 8) Retry Semantics (Deterministic)

### Automatic Retry

- **Max attempts:** 3
- Only for transient failures:
  - Network errors
  - Timeouts
  - Provider 5xx
- Exponential backoff with jitter

### Manual Retry

- Always allowed
- Resets based on `failure_stage`

### Reset Rules

| `failure_stage` | Reset Behavior |
|-----------------|----------------|
| `upload` | Delete `media_file`, clear `file_sha256`, reset to `pending` |
| `extract` | Delete fragments, reset to `pending` |
| `transcribe` | Delete transcript fragments, reset to `pending` |
| `embed` | Delete embeddings/chunks, reset to `ready_for_reading` |

**Retry semantics:**
- Manual retry always sets `processing_status = pending`, clears failure fields, enqueues job.
- Job runner transitions `pending → extracting` deterministically.
- For `failure_stage = transcribe`, the job runner picks up from the transcript phase (within extraction).
- For `failure_stage = embed`, reset to `ready_for_reading` since readable artifacts exist.

**No partial state may survive a reset.**

---

## 9) Idempotency Rules

### URL-Based Media

**Canonicalization:**
- Lowercase scheme + host
- Drop fragments
- Remove `utm_*`, `gclid`, `fbclid`
- Follow redirects once

**Store:**
- `requested_url`
- `canonical_url`

**Idempotency key:** `(kind, canonical_url)`

Existing failed rows are reused and retried.

#### Forward-Compatibility Notes (S7/S8)

The `(kind, canonical_url)` key is the **temporary S1 invariant**. Later slices will add stronger identity keys:

| Kind | S1 Key | Future Key (S7/S8) |
|------|--------|-------------------|
| `web_article` | `(kind, canonical_url)` | Same (stable) |
| `video` | `(kind, canonical_url)` | `(kind, provider, provider_video_id)` — e.g., `(video, youtube, dQw4w9WgXcQ)` |
| `podcast_episode` | `(kind, canonical_url)` | `(podcast_id, episode_guid)` with fallback `(podcast_id, enclosure_url, published_at)` |

S1 schema should include nullable `provider`, `provider_id` fields on `media` to support future constraints without migration.

**Rationale:** URL strings are fragile identifiers for videos (URL format changes) and podcasts (RSS feeds vary). Provider-native IDs are more stable.

---

### File Uploads (EPUB / PDF)

- **Hash:** sha256, stored as `media.file_sha256`
- Computed server-side during upload stream (preferred)
- **Idempotency key:** `(created_by_user_id, kind, file_sha256)`
- Enforced via unique partial index on `media` table
- Different users always get different media rows.

---

## 10) Storage Model

- Supabase Storage (private bucket)
- Path invariant:

```
media/{media_id}/original.{ext}
```

- No user identifiers in paths.

### Signed URLs

- Minted server-side only
- Expiry: **5 minutes**
- Returned only if `can_read(viewer, media)` passes

---

## 11) API Surface (Stable Contracts)

### Create / Upload

| Endpoint | Description |
|----------|-------------|
| `POST /media` | Creates media stub (kind + source) |
| `POST /media/upload/init` | Returns signed upload target |
| `POST /media/{id}/ingest` | Enqueues ingestion job |

#### `POST /media/upload/init` Contract

**Request:**
```json
{
  "kind": "pdf" | "epub",
  "filename": "document.pdf",
  "content_type": "application/pdf",
  "size_bytes": 1048576
}
```

**Response:**
```json
{
  "media_id": "uuid",
  "storage_path": "media/{media_id}/original.pdf",
  "upload_url": "https://...",
  "upload_headers": { "Content-Type": "application/pdf" },
  "expires_at": "2025-01-01T00:05:00Z"
}
```

**Flow:**
1. Client calls `POST /media/upload/init` with file metadata
2. Server creates `media` row with `processing_status = pending`, returns signed upload URL
3. Client uploads file directly to Supabase Storage using `upload_url` + `upload_headers`
4. Client calls `POST /media/{id}/ingest` to confirm upload and enqueue processing
5. Server computes `sha256` from stored file, checks idempotency, updates `media.file_sha256`
6. If duplicate found: return existing `media_id`, delete the just-uploaded file

**Idempotency check happens at ingest time**, not at init time (sha256 requires the file).

### Read / Retry

| Endpoint | Description |
|----------|-------------|
| `GET /media/{id}` | Returns metadata + processing_status + capabilities |
| `POST /media/{id}/retry` | Retries failed ingestion |
| `GET /media/{id}/file` | Returns signed URL (PDF/EPUB only) |

**All endpoints require:**
- Valid bearer token
- Internal secret header

### Visibility Enforcement (S1 Requirements)

All S1 endpoints must enforce media readability via library membership, consistent with constitution §8.

| Endpoint | Visibility Rule |
|----------|-----------------|
| `GET /media/{id}` | Returns 404 if viewer cannot read the media (no library membership) |
| `GET /media/{id}/file` | Returns 404 if viewer cannot read; only then checks `can_download_file` |
| `POST /media/{id}/retry` | Allowed only if viewer can read AND (viewer is creator OR viewer is admin of a containing library) |
| `POST /media/{id}/ingest` | Allowed only for media the viewer created |

**S1 inherits `library_media` from S0.** S1 must not bypass library membership checks even though S0 established them.

---

## 12) Job Architecture

- Celery tasks exist for each stage:
  - `ingest_media`
  - `retry_media`
- Tasks call **service-layer functions**
- No job writes fake fragments or artifacts
- Inline ingestion (dev):
  - Calls the same service functions synchronously
- Tests may run Celery in eager mode

---

## 13) Quota Hooks (Stubbed)

Introduce but do not enforce real limits.

### Operations

- `TRANSCRIBE_SECONDS`
- `LLM_TOKENS`
- `INGEST_URLS`

### Contract

```python
check_quota(user_id, operation, amount) -> allowed | denied
record_usage(user_id, operation, amount, media_id)
```

Called but always allowed in S1.

---

## 14) Testing Requirements

### Processing-State Test Suite

**Must cover:**
- All valid transitions
- Failed → retry → success
- No duplicate artifacts after retry
- `failed + playback-ok` semantics
- Idempotent URL + file ingest
- Signed URL access only when permitted

**Tests must run with:**
- Real DB
- Real storage bucket (test project)
- Inline ingestion + eager jobs

### Test Storage Isolation

All test uploads must use a run-scoped prefix to avoid polluting the storage bucket:

```
test_runs/{run_id}/media/{media_id}/original.{ext}
```

**Requirements:**
- `run_id` is a unique identifier per test run (e.g., CI job ID or UUID)
- Test teardown deletes the `test_runs/{run_id}/` prefix (best-effort)
- Production code uses `media/{media_id}/...`; test code overrides the prefix
- Tests must never write to the production path pattern

**CI cleanup:** If teardown fails, a scheduled job should clean up old `test_runs/*` prefixes (e.g., older than 24 hours).

---

## 15) Acceptance Criteria

- Media lifecycle transitions are deterministic
- Idempotency works for URLs and uploads
- Failed media can be retried without residue
- Signed URLs are secure and expire
- Capabilities object is correct and used everywhere
- Inline ingestion behaves identically to job ingestion
- Processing-state test suite passes

---

## 16) Non-Negotiable Invariants

- No partial derived state survives retries
- Capabilities, not status, drive UI behavior
- Media rows are reused for same canonical source
- Storage is never directly accessible by clients
- No fake extraction artifacts in S1
