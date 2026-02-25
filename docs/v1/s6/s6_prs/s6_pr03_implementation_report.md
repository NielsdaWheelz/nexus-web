# S6 PR-03 Implementation Report: PDF Processing Readiness and Text Artifacts

## 1. Summary of Changes

### New Files
- **`python/nexus/services/pdf_ingest.py`** — PDF extraction domain service. Owns normalization, PyMuPDF parsing, page-span construction, validation, artifact persistence, and invalidation helpers. Parser-agnostic typed outcomes at the public interface.
- **`python/nexus/services/pdf_lifecycle.py`** — PDF ingest-confirm and retry lifecycle orchestration. Owns state transitions, creator checks, retry inference matrix (D11), embedding-only vs text-rebuild paths, invalidation sequencing, and unified retry routing.
- **`python/nexus/tasks/ingest_pdf.py`** — Celery task for async PDF extraction. Owns `extracting → ready_for_reading` / `extracting → failed` transitions, embedding handoff, and embed-stage failure attribution.
- **`python/nexus/services/pdf_readiness.py`** — Shared DB-backed PDF quote-readiness predicate. Single-media and batch helpers for detail and list capability gating.
- **`python/tests/test_pdf_ingest.py`** — Unit/integration tests for extraction domain logic (normalization, spans, scanned, password, parser mapping, invariant rollback).
- **`python/tests/test_pdf_ingest_task.py`** — Task-level tests for lifecycle transitions, idempotency, error handling, embedding handoff.

### Modified Files
- **`python/pyproject.toml`** — Added `PyMuPDF>=1.24.0` dependency.
- **`python/nexus/errors.py`** — Added `E_PDF_PASSWORD_REQUIRED` error code (422).
- **`python/nexus/services/capabilities.py`** — Added `pdf_quote_text_ready` parameter to `derive_capabilities`; PDF `can_quote`/`can_search` now gated by this explicit boolean instead of `has_plain_text`.
- **`python/nexus/services/media.py`** — Calls `is_pdf_quote_text_ready()` for PDF media and passes result to `derive_capabilities`.
- **`python/nexus/services/libraries.py`** — Calls `batch_pdf_quote_text_ready()` for PDF media in list and passes results to `derive_capabilities`.
- **`python/nexus/services/epub_lifecycle.py`** — Added PDF routing branch in `confirm_ingest_for_viewer` to delegate to `confirm_pdf_ingest`.
- **`python/nexus/api/routes/media.py`** — Retry route delegates to `retry_for_viewer_unified` which routes PDF vs EPUB. Avoids forbidden `nexus.db.models` import in route file.
- **`python/tests/test_upload.py`** — Added `TestPdfIngestLifecycle` (4 tests).
- **`python/tests/test_media.py`** — Added `TestPdfCapabilityDerivation` (5 tests) and `TestPdfRetry` (10 tests).
- **`python/tests/test_libraries.py`** — Added `TestLibraryListPdfCapabilities` (2 tests).
- **`python/tests/test_capabilities.py`** — Updated existing PDF test and added `test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input`.

## 2. Problems Encountered

1. **PyMuPDF `Pixmap.set_rect` API** — Creating an image-only PDF test fixture with `alpha=1` (RGBA) required a 4-element color tuple, not 3. Fixed by using `alpha=0` (RGB, 3-channel).

2. **PyMuPDF password detection** — `fitz.open()` does not raise an exception for AES-256 encrypted PDFs; it opens the document but pages are inaccessible. Required post-open `doc.needs_pass` check rather than relying solely on exception handling.

3. **Session lifecycle in task tests** — The `ingest_pdf` task closes its DB session in `finally: db.close()`. Tests that patch `get_session_factory` to inject the test session had the session closed underneath them. Fixed by adding `patch.object(db_session, "close")` following the established EPUB task test pattern.

4. **Session rollback in unexpected-error test** — The task's exception handler calls `db.rollback()`, which undid unflushed test data inserts. Fixed by committing test data before the task call, then using `db_session.expire_all()` before re-querying.

5. **Route structure test: forbidden DB model import** — `test_route_structure.py` enforces that route files must not import from `nexus.db.models`. The initial retry routing imported `Media` directly in the route. Fixed by moving the media-kind check into `pdf_lifecycle.retry_for_viewer_unified()`.

6. **Logger kwargs style mismatch** — `pdf_lifecycle.py` uses `logging.getLogger()` (stdlib) but some error calls used structlog-style kwargs. Fixed by using `%s` format strings.

7. **Retry endpoint status code** — The retry route returns 202, not 200. Fixed test assertions.

## 3. Solutions Implemented

- **Modular PDF pipeline** — Dedicated `pdf_ingest` (extraction domain), `pdf_lifecycle` (orchestration), `ingest_pdf` (async task), `pdf_readiness` (capability predicate) modules. Clean separation of concerns matching EPUB pattern.
- **Parser isolation** — All PyMuPDF-specific code (including `doc.needs_pass` check) contained in `_extract_with_pymupdf()`. Public interfaces use `PdfExtractionResult` / `PdfExtractionError` typed outcomes.
- **S6 normalization contract** — `normalize_pdf_text()` implements CRLF/CR→LF, FF→\n\n, NBSP→space, whitespace collapse, newline collapse, trim.
- **Page-span construction** — Per-page normalization with offset tracking through separator characters. `validate_page_spans()` enforces contiguity/coverage invariants.
- **Capability gating** — `pdf_quote_text_ready` explicit boolean seam in `derive_capabilities()`. DB-backed predicate checks non-null `plain_text`, non-null `page_count`, and matching span count.
- **Retry inference matrix (D11)** — Precedence: non-failed→409, password→terminal, embed→embedding-only, extract/upload/other→text-rebuild, transcribe→fail-closed.
- **Invalidation** — `invalidate_pdf_quote_match_metadata` resets `plain_text_match_status` to pending, clears offsets/version, clears `prefix/suffix`. Used before text-rebuild retries.

## 4. Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Module shape | Dedicated `pdf_lifecycle` + `pdf_ingest` + `ingest_pdf` + `pdf_readiness` | Mirrors proven EPUB split per D01. Avoids premature abstraction. |
| Parser | PyMuPDF with isolation in `pdf_ingest.py` | Per D02. Parser-agnostic outcomes at lifecycle/task layers. |
| Password detection | Post-open `doc.needs_pass` check | PyMuPDF opens some encrypted PDFs without exception. Explicit check required. |
| Retry routing | `retry_for_viewer_unified()` in `pdf_lifecycle.py` | Avoids forbidden DB import in route file while keeping routing clean. |
| Capability seam | `pdf_quote_text_ready` parameter | Per D05. Explicit, not overloading `has_plain_text`. |
| Readiness predicate | Lightweight DB check in `pdf_readiness.py` | Per D06/D07. Write-time invariant enforcement, read-time lightweight check. |
| Test session management | `patch.object(db_session, "close")` | Follows established EPUB task test pattern. |

## 5. Deviations from L4/L3/L2

None. All decisions follow the accepted decision ledger (D01–D12).

## 6. Commands to Run New/Changed Behavior

```bash
# PDF upload init (already supported)
POST /upload/init { "kind": "pdf", "filename": "test.pdf", "content_type": "application/pdf", "file_size": 12345 }

# PDF ingest confirm (new PDF lifecycle path)
POST /media/{id}/ingest

# PDF retry (new PDF retry inference matrix)
POST /media/{id}/retry

# GET media with PDF capabilities
GET /media/{id}
```

## 7. Commands Used to Verify Correctness

```bash
# Full verification (lint + format + all tests + migrations + frontend)
make verify

# Backend lint only
make lint-back

# Backend format only
make fmt-back

# Backend unit tests only
make test-back-unit

# Full backend tests with services
make test-back

# Specific PDF tests
cd python && NEXUS_ENV=test uv run pytest tests/test_pdf_ingest.py tests/test_pdf_ingest_task.py -v
```

Final `make verify` output: **1142 passed, 2 deselected, 0 failures. All verification checks passed.**

## 8. Traceability Table

| Acceptance Item | Files | Tests | Status |
|---|---|---|---|
| PDFs routed into S6 PDF processing lifecycle | `api/routes/media.py`, `pdf_lifecycle.py`, `test_upload.py` | `test_pr03_ingest_pdf_confirm_routes_to_pdf_lifecycle_and_dispatches`, `test_pr03_ingest_pdf_confirm_preserves_compat_response_fields`, `test_pr03_ingest_pdf_confirm_non_creator_forbidden`, `test_pr03_ingest_pdf_confirm_repeat_call_idempotent_without_redispatch` | PASS |
| PDF produces page_count, plain_text, page_spans | `pdf_ingest.py`, `ingest_pdf.py`, `test_pdf_ingest.py`, `test_pdf_ingest_task.py` | `test_pr03_pdf_ingest_extracts_page_count_plain_text_and_page_spans`, `test_pr03_pdf_plain_text_normalization_matches_s6_contract`, `test_pr03_ingest_pdf_task_marks_ready_for_reading_on_success` | PASS |
| Extraction hands off to embedding pipeline | `ingest_pdf.py`, `pdf_lifecycle.py`, `test_pdf_ingest_task.py` | `test_pr03_ingest_pdf_task_hands_off_to_embedding_pipeline_after_successful_extraction`, `test_pr03_ingest_pdf_task_handoff_failure_marks_failed_with_embed_stage_and_preserves_extracted_artifacts` | PASS |
| Page-span lifecycle invariant enforcement | `pdf_ingest.py`, `test_pdf_ingest.py` | `test_pr03_pdf_ingest_fails_extract_when_page_spans_not_contiguous_after_text_extraction`, `test_pr03_pdf_ingest_fails_extract_when_page_span_set_incomplete_after_text_extraction`, `test_pr03_pdf_ingest_text_bearing_invariant_failure_rolls_back_partial_text_artifacts` | PASS |
| PDF quote-match metadata invalidation | `pdf_ingest.py`, `pdf_lifecycle.py`, `test_media.py` | `test_pr03_pdf_text_rebuild_invalidates_pdf_quote_match_metadata_and_prefix_suffix`, `test_pr03_pdf_invalidation_preserves_geometry_and_exact_text`, `test_pr03_retry_pdf_text_rebuild_path_invalidates_before_rewrite` | PASS |
| ready_for_reading vs quote readiness split | `pdf_ingest.py`, `media.py`, `libraries.py`, `capabilities.py`, `test_media.py`, `test_libraries.py`, `test_capabilities.py` | `test_pr03_get_media_pdf_can_read_before_can_quote_when_plain_text_not_ready`, `test_pr03_library_list_pdf_capabilities_match_detail_readiness_split`, `test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input` | PASS |
| Scanned/image-only and password-protected | `pdf_ingest.py`, `errors.py`, `test_pdf_ingest.py`, `test_media.py` | `test_pr03_pdf_ingest_scanned_or_image_only_marks_readable_without_quote_text`, `test_pr03_pdf_ingest_password_protected_fails_with_deterministic_error_code`, `test_pr03_get_media_pdf_scanned_visual_read_only_capabilities`, `test_pr03_retry_pdf_password_protected_returns_retry_not_allowed_without_dispatch` | PASS |
| Retry/rebuild honors S6 invalidation rules | `pdf_lifecycle.py`, `pdf_ingest.py`, `api/routes/media.py`, `test_media.py` | `test_pr03_retry_pdf_failed_resets_and_dispatches_text_rebuild_path`, `test_pr03_retry_pdf_route_preserves_compat_response_shape_without_mode_parameter`, `test_pr03_retry_pdf_embedding_only_path_does_not_rewrite_plain_text_or_page_spans`, `test_pr03_retry_pdf_embed_failure_uses_embedding_only_retry_inference_path`, `test_pr03_retry_pdf_transcribe_failure_stage_fails_closed_as_internal_integrity_error` | PASS |
| GET /media/{id} capability derivation reflects real readiness | `media.py`, `libraries.py`, `capabilities.py`, `pdf_readiness.py`, `test_media.py`, `test_libraries.py`, `test_capabilities.py` | `test_pr03_get_media_pdf_capabilities_use_real_quote_text_readiness_predicate`, `test_pr03_get_media_pdf_capabilities_do_not_flip_quote_search_on_plain_text_without_full_page_span_readiness`, `test_pr03_library_list_pdf_capabilities_use_same_quote_text_readiness_predicate_as_detail` | PASS |
| Embedding retry does not rewrite text artifacts | `pdf_lifecycle.py`, `test_pdf_ingest.py`, `test_media.py` | `test_pr03_embedding_retry_does_not_rewrite_pdf_text_artifacts_or_invalidate_matches`, `test_pr03_retry_pdf_embedding_only_path_does_not_rewrite_plain_text_or_page_spans` | PASS |

## 9. Commit Message

```
feat(s6-pr03): PDF processing readiness, text artifacts, and lifecycle

Implement S6 PR-03: PDF processing lifecycle/readiness semantics,
persisted normalized PDF text artifacts, retry invalidation rules,
and accurate PDF quote/search capability derivation.

New modules:
- nexus/services/pdf_ingest.py: PDF extraction domain service with
  PyMuPDF parser isolation, S6 text normalization contract, page-span
  construction/validation, artifact persistence, and invalidation helpers.
- nexus/services/pdf_lifecycle.py: PDF ingest-confirm and retry lifecycle
  orchestration with D11 precedence-ordered retry inference matrix
  (embedding-only vs text-rebuild vs terminal password), unified retry
  routing for routes, and invalidation sequencing.
- nexus/tasks/ingest_pdf.py: Celery task for async PDF extraction with
  extracting→ready_for_reading/failed transitions, embedding handoff,
  and embed-stage failure attribution (D12).
- nexus/services/pdf_readiness.py: Shared DB-backed PDF quote-readiness
  predicate (single + batch) for detail and list capability gating.

Modified modules:
- nexus/errors.py: Added E_PDF_PASSWORD_REQUIRED (422).
- nexus/services/capabilities.py: Added pdf_quote_text_ready parameter;
  PDF can_quote/can_search gated by explicit readiness, not has_plain_text.
- nexus/services/media.py: Calls is_pdf_quote_text_ready() for PDF detail.
- nexus/services/libraries.py: Calls batch_pdf_quote_text_ready() for lists.
- nexus/api/routes/media.py: Retry routes to retry_for_viewer_unified().
- nexus/services/epub_lifecycle.py: Confirm routes PDF to confirm_pdf_ingest.
- pyproject.toml: Added PyMuPDF>=1.24.0 dependency.

Test coverage:
- 15 new acceptance tests across test_upload.py, test_media.py,
  test_libraries.py, test_capabilities.py, test_pdf_ingest.py,
  and test_pdf_ingest_task.py covering all traceability matrix items.
- All 1142 tests pass. make verify clean.

Decisions: D01 (dedicated modules), D02 (PyMuPDF isolation), D03 (inferred
retry), D04 (password terminal), D05 (explicit capability seam), D06/D07
(shared readiness predicate), D08 (fail-closed invariants), D09 (idempotent
confirm), D10 (batched readiness), D11 (retry matrix), D12 (embed-stage
handoff failure).
```
