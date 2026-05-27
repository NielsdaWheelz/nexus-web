# Spec: Per-Stage Reingest — Metadata Retry & Broadened Source Refresh

Status: implemented; reliability hardened
Owner: ingestion pipeline
Hard cutover. No legacy retry API fallback and no backward compatibility for body-less retry calls.

Metadata retry/API behavior remains here. The enrichment policy itself is now
defined by `docs/metadata-enrichment-structured-overwrite-cutover.md`:
structured output, all-fields requests, overwrite by default, and no `force`
job payload.

---

## 1. Problem statement

The ingestion pipeline has four stages — fetch, extract, chunk, embed — plus a follow-on LLM metadata enrichment step. Today:

- The entire deterministic pipeline (fetch → extract → chunk → embed) runs as one monolithic job per media kind (`ingest_pdf`, `ingest_epub`, `ingest_web_article`, `ingest_youtube_video`). It's automatically retried up to 3 times by the job queue on transient failure.
- `enrich_metadata` runs as a separate job, dispatched at end of extract. It has `max_attempts=1`; failed task results are treated as failed background jobs for this job kind while still recording a soft `Media.failure_stage='metadata'` warning.
- `POST /api/media/{id}/retry` is the only user-triggerable retry, and it only works when `processing_status='failed'`.
- `POST /api/media/{id}/refresh` re-runs the source-acquisition path, but only for `web_article`, `video`, `podcast_episode`. Uploaded files (pdf, epub) cannot be refreshed.

**Concrete user pain:** an EPUB ingested cleanly — `processing_status='ready'` — but LLM metadata is "a little messy" (e.g., the title field still contains the file name). Metadata retry exists, but reliability hardening is required so malformed provider output, empty structured output, and provider misconfiguration are observable and do not look like successful work.

## 2. Goals

- G1. A user can re-run LLM metadata enrichment for any of their documents that have extracted content. The re-run is permitted to overwrite previously-populated metadata fields (not just fill gaps).
- G2. When metadata enrichment terminally fails, the failure is recorded on `Media` in a way the UI can surface as a soft warning — without flipping the doc out of `processing_status='ready'`.
- G3. A user can refresh the full deterministic pipeline (extract → chunk → embed) for any document — including uploaded pdf/epub — via the existing `POST /refresh` endpoint.
- G4. Per-stage UI semantics stay narrow: only `metadata` and `source` are exposed as user-controllable stages. Extract/chunk/embed remain deterministic and code-retried.

## 3. Non-goals

- NG1. No per-stage UI for extract / chunk / embed. These remain deterministic; their retry is owned by the job queue's automatic retry policy and by the existing `/retry` endpoint when the doc has terminally failed.
- NG2. No new failure-history table. Existing `Media.failure_stage` + `last_error_code` + `last_error_message` carry the most-recent failure state.
- NG3. No bulk endpoint or admin tooling. Single-doc actions only.
- NG4. No CLI script.
- NG5. No backward compatibility for `POST /retry`'s previously body-less shape. Hard cutover — body becomes required.
- NG6. No automatic re-enrichment cadence, scheduled retry, drift detection.
- NG7. No chat-agent public web-search tool loop for metadata enrichment. Public web lookup should be a separate bounded metadata service if added later.
- NG8. No command palette entries (palette is global-only post-cutover; `docs/command-palette-global-cutover.md`).
- NG9. No mobile (Android) changes — app is consumption-only.

## 4. Final state — target behavior

### 4.1. User-facing actions on the document pane header options menu

| Menu item | Visible when | Action |
|---|---|---|
| Retry processing | `capabilities.can_retry` | `POST /retry {from_stage: "source"}` |
| Refresh source | `capabilities.can_refresh_source` | `POST /refresh` |
| Re-enrich metadata | `capabilities.can_retry_metadata` | `POST /retry {from_stage: "metadata"}` |

These three items are mutually-exclusive in practice for `can_retry` ↔ `can_retry_metadata` (gated on `processing_status`); the user sees at most one of {Retry, Re-enrich metadata} plus optionally Refresh.

### 4.2. Soft warning indicator

When `Media.failure_stage='metadata' AND processing_status='ready'`, the pane header shows a small "Metadata enrichment failed" indicator with an inline "Re-enrich" button.

### 4.3. Capability contract (final)

`CapabilitiesOut` (`python/nexus/schemas/media.py:16-31`):

```python
class CapabilitiesOut(BaseModel):
    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_search: bool
    can_play: bool
    can_download_file: bool
    can_delete: bool = False
    can_retry: bool = False
    can_refresh_source: bool = False
    can_retry_metadata: bool = False   # NEW
```

Derivation (final, in `python/nexus/services/capabilities.py:derive_capabilities`):

- `can_retry`: **unchanged.** `is_creator AND kind ∈ {pdf, epub, web_article} AND processing_status='failed' AND retry_source_available AND not terminal_retry_error`.
- `can_refresh_source`: **broadened.** `is_creator AND kind ∈ {pdf, epub, web_article, video, podcast_episode} AND source_refresh_available AND processing_status ∈ {ready_for_reading, embedding, ready, failed}`. For pdf/epub, `source_refresh_available = media_file_exists`. For others, unchanged.
- `can_retry_metadata`: **new.** `is_creator AND metadata_enrichment_supported(kind) AND processing_status ∈ {ready_for_reading, embedding, ready}`. Supported kinds = all five (enrichment runs for every media kind today).

### 4.4. API contract (final)

#### POST /api/media/{id}/retry

Request body **required**:

```json
{ "from_stage": "source" | "metadata" }
```

`from_stage="source"`:
- Preconditions: viewer is creator; `processing_status='failed'`; kind ∈ {pdf, epub, web_article}; capability `can_retry` is true.
- Behavior: identical to today's `retry_for_viewer_unified`. Dispatches by kind.
- Errors:
  - 422 if body missing or `from_stage` invalid (FastAPI default).
  - 409 `E_RETRY_INVALID_STATE` if status not 'failed'.
  - 409 `E_RETRY_NOT_ALLOWED` for terminal errors (`E_PDF_PASSWORD_REQUIRED`, `E_ARCHIVE_UNSAFE`).
  - 403 if not creator.
  - 404 if not visible to viewer.
- Response 202: `{media_id, processing_status: "extracting", retry_enqueued: bool}`.

`from_stage="metadata"`:
- Preconditions: viewer is creator; `processing_status ∈ {ready_for_reading, embedding, ready}`; capability `can_retry_metadata` is true.
- Behavior: enqueues `enrich_metadata` job with payload `{media_id, request_id}`. The job's only policy is structured-output overwrite by default.
- Errors:
  - 422 if body missing or `from_stage` invalid.
  - 409 `E_RETRY_INVALID_STATE` if status not in the allowed set.
  - 403 if not creator.
  - 404 if not visible.
- Response 202: `{media_id, processing_status: <unchanged>, metadata_enrichment_enqueued: true}`.

#### POST /api/media/{id}/refresh

Body still empty. Eligibility broadens:

- Accepted kinds: `web_article`, `video`, `podcast_episode`, `pdf`, `epub`.
- For pdf/epub: `source_refresh_available = media_file_exists`. Re-runs the same ingest job that the original upload would have enqueued, with `embedding_only=false`. Same `ContentIndexRun` versioning applies — old runs are superseded.
- For url-backed kinds: unchanged semantics.
- Preconditions: viewer is creator; `processing_status ∈ {ready_for_reading, embedding, ready, failed}`; source available.
- Errors:
  - 409 `E_MEDIA_NOT_READY` if status not in allowed set.
  - 409 `E_RETRY_NOT_ALLOWED` if the source isn't available (e.g., url missing for url-backed, file missing for upload-backed).
  - 403 if not creator.
  - 404 if not visible.
- Response 202: `{media_id, processing_status, refresh_enqueued: bool}`.

`E_INVALID_KIND` is no longer thrown — all five kinds are valid.

### 4.5. `enrich_metadata` behavior (final)

```python
def enrich_metadata(media_id: str, request_id: str | None = None) -> dict
```

Flow:

1. Load `Media`. Skip if missing (`{status:"skipped", reason:"media_not_found"}`).
2. Skip if `processing_status == 'extracting'` (`reason: "not_ready"`).
3. Select configured structured-output providers in reliability-first fallback order. If none are configured, record `E_METADATA_NO_PROVIDER`.
4. Build all-fields metadata context. Current metadata is an untrusted hint, not a gate.
5. Call LLM providers with bounded fallback. Read `response.structured_output` and validate it with the strict local Pydantic contract before merging.
6. On **any** terminal failure path (`llm_failed`, `llm_incomplete`, `parse_failed`, `no_fields`, `unexpected_error`):
   - Set `media.failure_stage = FailureStage.metadata`.
   - Set `media.last_error_code` (LLM error class or fixed code like `E_METADATA_PARSE_FAILED`).
   - Set `media.last_error_message` (truncated to 1000 chars).
   - Update `media.updated_at`.
   - **Do not modify** `media.processing_status`.
   - Commit.
   - Return `{status: "failed", reason: ..., error_code: ..., attempted_providers: [...]}`. The worker records that result on the background job failure/dead row.
7. On success:
   - Apply every valid non-empty field returned by the model. Existing populated metadata does not block replacement.
   - If at least one field is accepted, set `media.metadata_enriched_at = now()` and `media.updated_at = now()`.
   - Clear `media.failure_stage / last_error_code / last_error_message` if they were `metadata`-related.
   - Commit.
   - Return `{status: "success", fields: [...], provider: ..., model: ...}`.

`max_attempts` stays at 1. The user is the retry boundary.

## 5. Architecture

```
                      ┌─────────────────────────────────┐
                      │  POST /retry  {from_stage}      │
                      │  python/nexus/api/routes/       │
                      │    media.py                     │
                      └──────┬───────────────────┬──────┘
                             │                   │
                  from_stage=source       from_stage=metadata
                             │                   │
                             ▼                   ▼
       ┌────────────────────────────┐  ┌────────────────────────────┐
       │ retry_for_viewer_unified() │  │ retry_metadata_for_viewer()│
       │ services/pdf_lifecycle.py  │  │ services/metadata_         │
       │  → kind dispatch           │  │   lifecycle.py             │
       │  → enqueue ingest_{kind}   │  │  → enqueue enrich_metadata │
       │     (deterministic         │  │     payload {media_id,     │
       │      pipeline)             │  │      request_id}           │
       └────────────────────────────┘  └────────────────────────────┘

                      ┌─────────────────────────────────┐
                      │  POST /refresh                  │
                      │  api/routes/media.py            │
                      └──────────────┬──────────────────┘
                                     │
                                     ▼
                  ┌──────────────────────────────────────────┐
                  │ media_service.refresh_source_for_viewer  │
                  │  - web_article|video|podcast: existing   │
                  │  - pdf|epub (NEW): re-enqueue ingest_*   │
                  │    with embedding_only=false             │
                  └──────────────────────────────────────────┘
```

## 6. Composition with other systems

- **Job queue (`background_jobs`):** all retries go through `enqueue_job()`. No dedupe key on the new metadata enqueue — repeated clicks may produce repeated jobs (frontend gate is the only mitigation; per-click cost is one LLM call, which is acceptable).
- **`enrich_metadata` JobDefinition** (`python/nexus/jobs/registry.py:101-107`): no change. `max_attempts=1`, `retry_delays_seconds=(0,)`, `lease_seconds=120`. Handler payload is `{media_id, request_id?}`.
- **`ContentIndexRun` versioning** (`python/nexus/db/models.py:2627`): unchanged. Source refresh follows the existing path; old runs are superseded via `superseded_by_run_id`. No deletion of historical chunks/embeddings.
- **`Media.failure_stage`**: gains a new value `metadata`. Semantic shift — when set to `metadata`, `processing_status` stays `ready`. All other values continue to imply `processing_status='failed'`. Audit responsibility in §11.
- **`derive_capabilities` callers**: every consumer of `CapabilitiesOut` automatically receives `can_retry_metadata=false` (Pydantic default) until the backend computes it.
- **Frontend pane menu (`mediaResourceOptions`)**: three flat menu items, conditionally rendered.

## 7. Files — new and changed

### 7.1. Database

- **NEW** `migrations/alembic/versions/0109_failure_stage_metadata.py`
  - `op.execute("ALTER TYPE failure_stage_enum ADD VALUE 'metadata' BEFORE 'other'")`
  - Postgres ≥ 12 supports `ALTER TYPE ... ADD VALUE` in a transaction; project tech stack already on a modern Postgres, so this is one-shot.
  - Downgrade: no-op (Postgres does not support removing enum values without recreating the type; per "no fallbacks" rule, accept this irreversibility — value can sit unused if rolled back).

### 7.2. Backend Python

- **CHANGE** `python/nexus/db/models.py:85-95` — add `metadata = "metadata"` to `FailureStage`.
- **CHANGE** `python/nexus/services/metadata_enrichment.py`:
  - Remove gap-gated application from metadata enrichment.
  - Request all metadata fields through provider-native structured output.
  - Validate structured provider output locally.
  - Apply every valid non-empty returned field, overwriting populated metadata.
- **CHANGE** `python/nexus/tasks/enrich_metadata.py`:
  - No `force` parameter.
  - No `no_gaps` early return.
  - Build structured `LLMRequest`.
  - Read `response.structured_output`; do not parse text/markdown/prose.
  - Replace `return {"status":"skipped", "reason":"llm_failed"}` (and the three sibling branches) with a helper `_record_metadata_failure(db, media, error_code, error_message)` that writes `failure_stage=metadata`, `last_error_*`, commits, and returns `{"status":"failed", "reason":...}`.
  - On success: if previous `failure_stage` was `metadata`, clear it (and `last_error_*`) inside the same commit as the metadata write.
- **CHANGE** `python/nexus/jobs/registry.py:_run_enrich_metadata` (line 255-261) — pass only `media_id` and optional `request_id`.
- **NEW** `python/nexus/services/metadata_lifecycle.py`:
  - `retry_metadata_for_viewer(db, viewer_id, media_id, *, request_id) -> dict`
  - Mirrors style of `pdf_lifecycle.retry_for_viewer_unified` (permission check, state check, enqueue).
  - Validates: creator, `processing_status ∈ {ready_for_reading, embedding, ready}`.
  - Calls `enqueue_job(db, kind="enrich_metadata", payload={"media_id": str(media.id), "request_id": request_id})`.
  - Returns `{"media_id": str(media.id), "processing_status": media.processing_status.value, "metadata_enrichment_enqueued": True}`.
- **CHANGE** `python/nexus/api/routes/media.py:425-453`:
  - Add `RetryRequest` Pydantic model in `schemas/media.py` with `from_stage: Literal["source", "metadata"]`, `extra="forbid"`.
  - `retry_ingest` accepts `body: RetryRequest`.
  - Branches: `source` → `retry_for_viewer_unified(...)`; `metadata` → `retry_metadata_for_viewer(...)`.
- **CHANGE** `python/nexus/services/media.py:refresh_source_for_viewer` (line 452+):
  - Drop the kind whitelist that raises `E_INVALID_KIND`.
  - Add branches: `pdf` → `confirm_pdf_ingest`-equivalent re-enqueue (without re-validating the upload — just enqueue `ingest_pdf` with `embedding_only=false`); `epub` → same for epub.
  - Source-availability check for pdf/epub: `media.media_file is not None`; if missing, raise `E_RETRY_NOT_ALLOWED`.
- **CHANGE** `python/nexus/services/capabilities.py`:
  - Add `pdf`, `epub` to `_SOURCE_REFRESH_MEDIA_KINDS`.
  - In `derive_capabilities`, compute `source_refresh_available` to include `media_file_exists` for pdf/epub.
  - Add parameter `metadata_enrichment_supported: bool = True` (all kinds supported today; parameter exists for future control).
  - Compute `can_retry_metadata = is_creator AND metadata_enrichment_supported AND processing_status ∈ {ready_for_reading, embedding, ready}`.
  - Return `can_retry_metadata` in `CapabilitiesOut`.
- **CHANGE** `python/nexus/schemas/media.py:CapabilitiesOut` — add `can_retry_metadata: bool = False`.
- **CHANGE** `python/nexus/schemas/media.py` — add `RetryRequest` body model.
- **CHANGE** `python/nexus/services/media.py:_media_out_from_row` (line ~353) — pass `metadata_enrichment_supported=True` (or kind-derived if we ever gate it).

### 7.3. Frontend TypeScript

- **CHANGE** `apps/web/src/lib/actions/resourceActions.ts:mediaResourceOptions`:
  - Extend `MediaActionSubject.capabilities` literal with `can_retry_metadata?: unknown`.
  - Add input fields `onRetryMetadata?: () => void`, `retryMetadataBusy?: boolean`.
  - Push a menu item between "refresh-source" and "chat-about-media" when `capabilities?.can_retry_metadata === true && input.onRetryMetadata`. Label: `"Re-enrich metadata"` or `"Re-enriching..."` while busy.
- **CHANGE** `apps/web/src/lib/media/useDocumentActions.ts`:
  - Update `handleRetry` to POST `{from_stage: "source"}` as JSON body.
  - Add `retryMetadataBusy` state.
  - Add `handleRetryMetadata` that POSTs `{from_stage: "metadata"}` to `/api/media/{id}/retry`. On success: toast "Metadata re-enrichment started." **Do not** call `onProcessingRestarted` — the doc remains readable.
  - Extend `DocumentActions` return shape with `retryMetadataBusy`, `handleRetryMetadata`.
  - Extend `DocumentActionTarget.capabilities` with `can_retry_metadata?: boolean`.
- **CHANGE** `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`:
  - Thread `retryMetadataBusy` and `handleRetryMetadata` into `mediaResourceOptions({ ..., onRetryMetadata: handleRetryMetadata, retryMetadataBusy })`.
  - Render the soft warning indicator (chip in pane header) when `media.processing_status === 'ready' && media.failure_stage === 'metadata'`. Clicking the chip triggers `handleRetryMetadata`.
- **CHANGE** `apps/web/src/lib/types/media.ts` (or wherever `Media`/`MediaCapabilities` TS types live; discover by grep) — add `can_retry_metadata: boolean` to capabilities.
- **CHANGE** `apps/web/src/lib/actions/resourceActions.ts:episodeResourceOptions` — pass through the new `onRetryMetadata`/`retryMetadataBusy` props so podcast-episode panes also get the menu item.

### 7.4. Tests

- **NEW** `python/tests/api/routes/test_media_retry_metadata.py` — covers `from_stage="metadata"` happy path, permission, state preconditions, capability gating, body validation.
- **CHANGE** `python/tests/api/routes/test_media_retry.py` (or equivalent) — every test now sends `{from_stage: "source"}`. Add a test asserting a body-less call returns 422.
- **CHANGE** `python/tests/services/test_capabilities.py` — cover `can_retry_metadata` true/false matrix; cover broadened `can_refresh_source` for pdf/epub.
- **CHANGE** `python/tests/tasks/test_enrich_metadata.py`:
  - Automatic path never skips `no_gaps`.
  - Automatic path overwrites populated fields (regression: assert title changes when previously populated).
  - LLM failure path writes `failure_stage='metadata'` and `last_error_*` while leaving `processing_status='ready'`.
  - Successful path clears `failure_stage` if previously `metadata`.
- **CHANGE** `python/tests/services/test_media.py:test_refresh_source_for_viewer*` — add pdf/epub eligibility cases; add file-missing → 409 case for pdf/epub.
- **CHANGE/NEW** `apps/web/e2e/...` — Playwright test for the "Re-enrich metadata" action and the soft-warning chip's appearance/disappearance.

## 8. Key decisions

1. **`from_stage` vocabulary** = `"source" | "metadata"`. `source` (not `extract` or `fetch`) reads naturally for both URL-backed and file-backed media; the deterministic pipeline as a whole IS the source-reprocessing path. `metadata` (not `llm_metadata` or `enrich`) is shorter and aligns with the column name.
2. **Metadata enrichment overwrites by default.** The user's pain is "metadata is messy" — those messy fields are often already populated. Manual and automatic enrichment use the same structured-output overwrite policy.
3. **Soft warning over hard failure** for metadata: `failure_stage='metadata'` while `processing_status='ready'`. Per user direction. Decouples the historically-coupled enum semantics.
4. **One `/retry` endpoint with body** instead of two endpoints. Avoids endpoint proliferation and makes the stage selection explicit at every call site.
5. **Hard cutover: body required.** No `from_stage` default. Forces explicitness; any client that called the old endpoint silently is broken loudly, which is the desired behavior.
6. **Broaden `/refresh` instead of adding `/reprocess`.** Same user intent, same backend mechanics for pdf/epub as for url-backed kinds.
7. **`max_attempts=1` stays** on `enrich_metadata`. The user is the retry boundary; provider fallback inside one attempt is allowed because it is the smallest useful operation boundary.
8. **No dedupe on the metadata enqueue.** Repeat clicks cost one LLM call each; frontend `retryMetadataBusy` is sufficient.
9. **No new failure-history table.** Most-recent-failure semantics on `Media` match the rest of the codebase. `background_jobs` retains job-level history.
10. **No backend rate limit on re-enrich.** Per simplicity rule. Reconsider if abuse becomes a real problem.

## 9. Invariants (enforced by tests)

- **I1.** `Media.processing_status` is never written by `enrich_metadata`.
- **I2.** `Media.failure_stage='metadata'` implies `processing_status ∈ {pending, ready_for_reading, embedding, ready}` (never `failed`).
- **I3.** A successful `enrich_metadata` run clears `failure_stage`/`last_error_*` iff the previous value of `failure_stage` was `metadata`. It does not touch other failure_stage values.
- **I4.** Every valid non-empty structured field may overwrite already-populated metadata.
- **I5.** `POST /retry` with empty/invalid body returns 422; `{from_stage: "source"}` preserves today's behavior; `{from_stage: "metadata"}` enqueues enrichment.
- **I6.** `can_retry_metadata` and `can_retry` are never both true (mutual exclusion via `processing_status`).
- **I7.** `POST /refresh` accepts pdf/epub iff `media_file_exists AND processing_status ∈ {ready_for_reading, embedding, ready, failed}`.
- **I8.** Every entry point validates creator + read permission.

## 10. Acceptance criteria

- **A1.** A user opens an EPUB whose `title` is filename-shaped (e.g., ends in `.epub`). The "Re-enrich metadata" item is visible in the pane header options menu. Clicking it enqueues a job that completes within 2 minutes. After a pane refresh, `title`, `publisher`, `description`, etc. reflect the new LLM-supplied values even if they previously held populated (but messy) data.
- **A2.** A user opens a PDF in `processing_status='ready'`. The "Refresh source" item is visible. Clicking it re-enqueues `ingest_pdf`. The previous `ContentIndexRun` is marked superseded; a new one becomes active.
- **A3.** A user clicks "Re-enrich metadata"; the LLM call fails (e.g., quota exhausted). The doc shows `failure_stage='metadata'`, `last_error_code` populated, `processing_status='ready'`. The pane header renders a "Metadata enrichment failed — Re-enrich?" chip.
- **A4.** A subsequent successful re-enrich clears the chip and `failure_stage`.
- **A5.** "Retry processing" on a `failed` doc behaves exactly as today (no UX regression).
- **A6.** `curl -X POST /api/media/{id}/retry` with no body returns HTTP 422.
- **A7.** Two rapid clicks on "Re-enrich metadata" produce at most one in-flight UI request (button disabled) and at most two backend LLM calls; second click is functionally a no-op if the first hasn't returned.
- **A8.** `POST /refresh` on a PDF whose `media_file` was deleted returns 409 `E_RETRY_NOT_ALLOWED`.
- **A9.** A non-creator viewer never sees the menu items; calling the endpoints directly returns 403.

## 11. Risks and mitigations

- **R1. `failure_stage` semantic shift.** Today every reader of `failure_stage` may implicitly assume `processing_status='failed'`. Mitigation: grep `failure_stage` across backend and frontend; the only backend reader is `retry_pdf_ingest_for_viewer` (which already gates on `processing_status=='failed'` before reading `failure_stage`, so it's safe). Frontend reader is the response surface (`MediaOut.failure_stage`) — update consumers to interpret `metadata + ready` as soft warning, anything else with status≠failed as defect-shaped. Document the new semantics in the model docstring.
- **R2. Postgres enum add.** `ALTER TYPE failure_stage_enum ADD VALUE 'metadata'` requires Postgres ≥ 12 for in-transaction execution. Project is on a modern Postgres — confirm in CI before the migration ships.
- **R3. Overwrite trust.** Metadata enrichment can clobber good fields. Accepted for this one-user prototype; manual re-enrich and source refresh are the recovery paths.
- **R4. Cost / abuse.** One LLM call per click; no rate limit. Mitigated by frontend gate + per-user trust model. If abuse appears, add a 1-per-minute server-side throttle keyed on `(user_id, media_id)`.
- **R5. EPUB refresh parity.** EPUB upload/confirm path may have setup beyond just enqueueing `ingest_epub`. Implementation step 1: inspect `confirm_epub_ingest` and `retry_epub_ingest_for_viewer` and verify that the refresh path calls the right entry point. If extra setup is needed (e.g., re-validating archive safety), bring it into the refresh path.
- **R6. Stage taxonomy drift.** `FailureStage` and `ContentIndexRun.state` already diverged (the survey caught this). Adding `metadata` to `FailureStage` without adding a parallel `metadata` state to `ContentIndexRun.state` is intentional: enrichment isn't an index run. Document this in the `FailureStage` docstring.

## 12. Open implementation choices (non-blocking)

- O1. Soft-warning chip placement in `MediaPaneBody.tsx` — header chip vs. banner above doc body. Choose during implementation; header chip is the default per pane conventions.
- O2. Translating the FastAPI 422 from a body-less `/retry` into a friendlier `E_INVALID_REQUEST` envelope. Default: leave as 422.
- O3. Whether `metadata_enriched_at` bumps when a run produces no accepted fields. Current behavior: no. Empty or non-applicable output is a visible metadata failure (`E_METADATA_NO_FIELDS`) rather than a silent successful no-op.
- O4. Whether the "Re-enrich metadata" item is always visible when capability is true, or hidden by default and surfaced only when `failure_stage='metadata'` plus a "More" expansion. Default: always visible.

## 13. Out-of-scope follow-ups (won't be done in this change)

- Bulk re-enrich across a library or filter.
- Operator CLI tooling.
- Drift detection (e.g., flagging docs whose metadata looks suspicious automatically).
- Multi-model enrichment (e.g., letting the user pick a different model for the retry).
- Per-field re-enrich (e.g., "just re-do the title, leave the description").
- Model attribution on enriched fields (the `merge_enrichment` path already records via `source="metadata_enrichment"` on contributor credits; no per-field model annotation is added here).
