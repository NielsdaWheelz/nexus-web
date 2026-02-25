# pr-03: pdf processing readiness and text artifacts

## goal
Implement S6 PDF processing lifecycle/readiness semantics, persisted normalized PDF text artifacts (`media.plain_text`, `pdf_page_text_spans`), retry invalidation rules, and accurate PDF quote/search capability derivation.

## context
- `docs/v1/s6/s6_pr_roadmap.md` defines `pr-03` as the owner of PDF processing/readiness, `pdf_page_text_spans` lifecycle invariants, retry invalidation rules, scanned/protected behavior, and accurate PDF quote/search capability gating (`pdf_quote_text_ready(media)`) on media read surfaces.
- `docs/v1/s6/s6_spec.md` Section `2.1` defines PDF `media.plain_text` normalization and `page_count` constraints; Section `2.2` defines `pdf_page_text_spans`; Section `2.4` defines PDF quote-match invalidation requirements; Section `3.1` defines the PDF lifecycle/read-vs-quote readiness split; Section `4.1` extends `GET /media/{id}` capability behavior.
- `docs/v1/s6/s6_spec_decisions.md` fixes relevant S6 constraints:
  - `S6-D03` (`GET /media/{id}/file` reuse)
  - `S6-D05` (PDF quote-match metadata contract)
  - `S6-D06` (invalidation+recompute instead of artifact-generation version binding)
- `docs/v1/s6/s6_prs/s6_pr01_implementation_report.md` documents the actual `pr-01` schema/model foundation now available to `pr-03`:
  - `media.plain_text`, `media.page_count`
  - `pdf_page_text_spans`
  - `highlight_pdf_anchors` quote-match metadata fields (for invalidation targets)
- Current backend upload/ingest routing is EPUB-specific at the lifecycle layer:
  - `POST /media/{id}/ingest` and `POST /media/{id}/retry` routes delegate to `epub_lifecycle` (`python/nexus/api/routes/media.py`)
  - `python/nexus/services/epub_lifecycle.py` and `python/nexus/tasks/ingest_epub.py` are the closest implementation pattern for `pr-03`
- Upload initialization already supports `kind='pdf'` and `kind='epub'` with file validation and storage path allocation (`python/nexus/services/upload.py`), but there is currently no PDF extraction/lifecycle service or task.
- `python/nexus/services/capabilities.py` already contains the S6-style PDF read-vs-quote capability split, but it currently uses a placeholder boolean seam (`has_plain_text`) and media/library callers still pass `False` placeholders (`python/nexus/services/media.py`, `python/nexus/services/libraries.py`).
- Greenfield production assumption applies (zero existing production data), but `pr-03` must still implement full retry/rebuild invalidation semantics now because later `pr-04`/`pr-05` will create and consume PDF quote-match metadata.

## dependencies
- pr-01

---

## deliverables

### `python/nexus/services/pdf_lifecycle.py`
- Add PDF-specific ingest-confirm and retry lifecycle orchestration for `kind='pdf'`, mirroring the EPUB split of route orchestration vs async task completion.
- Own legal-state guards, creator checks, retry guards, deterministic error mapping, and dispatch of the PDF extraction task.
- Treat password-protected/encrypted PDF failures (`E_PDF_PASSWORD_REQUIRED`) as terminal for the public retry route in S6 (`409 E_RETRY_NOT_ALLOWED`), consistent with v1 no-password-flow constraints.
- Keep public `POST /media/{id}/retry` route compatibility in `pr-03` (existing request/response shape; no retry-mode request parameter).
- Own lifecycle transitions for entry/reset phases:
  - `pending -> extracting` on confirm/dispatch
  - `failed -> extracting` on legal retry
- Own retry/rebuild invalidation behavior for PDF text artifacts and dependent PDF quote-match metadata (`highlight_pdf_anchors.plain_text_match_*`, `highlights.prefix/suffix`) per S6 invalidation rules.
- Distinguish retry modes sufficiently to enforce:
  - embedding/search-only retries do not rewrite `media.plain_text` / `pdf_page_text_spans`
  - text rebuild/repair paths that rewrite text artifacts invalidate quote-match metadata first
- Implement the `pr-03` retry-mode split as:
  - public user-facing retry via `POST /media/{id}/retry` with inferred behavior from lifecycle/failure context
  - explicit internal rebuild/repair helper(s) for text-artifact rewrites/operator rebuild paths
- Reuse `upload.confirm_ingest(...)` / `upload.validate_source_integrity(...)` where appropriate; do not duplicate base upload hashing/dedup logic unnecessarily.
- Keep route-facing response compatibility with existing ingest/retry schemas (`media_id`, `duplicate`, `processing_status`, `ingest_enqueued` / `retry_enqueued`).

### `python/nexus/services/pdf_ingest.py`
- Add the PDF extraction domain service (no route logic, no Celery dispatch) responsible for deterministic PDF artifact production.
- Implement PDF parsing with **PyMuPDF** in `pr-03`, while keeping parser-specific exception handling/mapping isolated inside this module behind parser-agnostic typed outcomes.
- Define typed result/error outputs for PDF extraction (success vs deterministic extraction error) similar to EPUB extract service patterns.
- Produce and persist in one extraction transaction:
  - `media.page_count`
  - normalized `media.plain_text` (parser-agnostic S6 normalization contract)
  - `pdf_page_text_spans` rows (page-indexed offsets over post-normalization `plain_text`)
- Enforce/validate `pr-03` lifecycle-owned PDF text invariants before quote-capable readiness can be considered satisfied:
  - one row per page `1..page_count`
  - contiguous/full page-set coverage
  - offsets over the same normalization pass output
- If a text-bearing extraction outcome fails page-span lifecycle invariants, fail closed as deterministic extract failure and leave no partial persisted quote-text artifacts (`media.plain_text`, `media.page_count`, `pdf_page_text_spans`) from that failed extraction attempt.
- Implement scanned/image-only degradation semantics:
  - renderable PDF may succeed to readable state with empty/absent normalized text
  - quote/search readiness remains false
- If implementation records a non-fatal scanned/no-text diagnostic for renderable PDFs with no usable extracted text (recommended: `E_PDF_TEXT_UNAVAILABLE`), it must not force `failed`, alter retry legality, or be surfaced as an ingest API error in `pr-03`.
- Implement password-protected/encrypted deterministic failure classification for v1 (`E_PDF_PASSWORD_REQUIRED`).
- Provide explicit helper(s) for text-artifact invalidation + optional deterministic enrichment enqueue hooks (no quote matching implementation in `pr-03`).
- Provide a synchronous runner/helper for backend tests (mirroring `run_epub_ingest_sync` pattern).
- Emit structured backend extraction outcome logs (at minimum outcome classification, parser engine, elapsed time, and page count when available; file size/byte length when cheaply available) to support large-PDF operability without frontend-style debug snapshots.

### `python/nexus/tasks/ingest_pdf.py`
- Add the Celery task that executes PDF extraction and owns async completion-state transitions:
  - `extracting -> ready_for_reading` (success; quote text may or may not be ready)
  - `extracting -> failed` (deterministic extraction failure)
- On successful extraction, perform the explicit handoff into the existing shared embedding pipeline / post-extract path (without redesigning the embedding subsystem in `pr-03`) so downstream embedding failures surface with `failure_stage='embed'` semantics.
- If the shared embedding/post-extract handoff fails synchronously after successful PDF extraction, classify the media as an embed-stage failure (`failure_stage='embed'`) without rolling back already-persisted extraction artifacts, so retry inference and embedding-only retry semantics remain correct.
- Preserve task idempotence/skip behavior for missing/non-`extracting` media rows.
- Ensure task writes lifecycle fields deterministically (`failure_stage`, `last_error_code`, `failed_at`, `processing_completed_at`, etc.).
- Avoid quote-match enrichment behavior beyond what `pr-03` explicitly owns (no `pr-05` quote rendering logic).

### `python/nexus/api/routes/media.py`
- Extend ingest-confirm and retry route delegation so PDF media uses the `pr-03` PDF lifecycle path while preserving existing EPUB behavior and route response shapes.
- Keep no-existence-leak and creator/authorization semantics intact through service-layer orchestration.
- Preserve existing endpoint contracts; no new PDF-specific ingest/retry routes and no retry-mode request parameter in `pr-03`.

### `python/nexus/services/media.py`
- Replace the PDF placeholder capability boolean with real DB-backed derivation for `GET /media/{id}` capability computation using an explicit PDF quote-readiness predicate (`pdf_quote_text_ready(media)`), not plain-text presence alone.
- Reuse the shared DB-backed PDF quote-readiness predicate helper chosen by `S6-PR03-D06` so media detail and library list stay consistent.
- Preserve existing media visibility masking and response schema shape.
- Ensure PDF `can_read` remains file-based while `can_quote/can_search` reflect real quote-text readiness via `derive_capabilities`.

### `python/nexus/services/libraries.py`
- Replace the PDF placeholder capability boolean with real DB-backed quote-readiness derivation for library media listing capabilities.
- Reuse the same shared DB-backed PDF quote-readiness predicate helper as `python/nexus/services/media.py` (per `S6-PR03-D06`) so list/detail capability semantics remain identical.
- Preserve library visibility and pagination behavior; no new fields in library list payloads.

### `python/nexus/services/capabilities.py`
- Replace or extend the PDF quote/search capability seam with an explicit quote-readiness boolean input (recommended: `pdf_quote_text_ready`) rather than overloading `has_plain_text`.
- Keep the pure function behavior aligned with S6 PDF lifecycle semantics:
  - PDF `can_quote/can_search` are gated by the explicit quote-readiness input (full `pdf_quote_text_ready(media)` semantics), not raw plain-text presence
  - avoid introducing DB access or duplicating lifecycle policy inside this function
- Do not move DB access into this module.

### `python/nexus/services/pdf_readiness.py`
- Add the shared DB-backed PDF quote-readiness predicate helper module used by both `python/nexus/services/media.py` and `python/nexus/services/libraries.py` (per `S6-PR03-D06`).
- Provide helpers sufficient for:
  - single-media quote-readiness derivation (detail view)
  - multi-media/batch quote-readiness derivation (library list) without N+1 queries
- Implement the shared read-time PDF quote-readiness predicate per `S6-PR03-D07`: use a lightweight fail-closed check over persisted artifacts (non-empty `plain_text`, `page_count`, and page-span coverage/count bounds) and rely on `pdf_ingest` / `pdf_lifecycle` for write-time contiguity validation. Do not re-run full contiguity validation in list reads.
- Keep helper(s) focused on DB-backed readiness derivation (no route formatting, no capability object construction).

### `python/nexus/errors.py`
- Add any S6 PDF ingestion error codes required by `pr-03` implementation (at minimum deterministic password/protection failure if used in API-visible or persisted `last_error_code` paths).
- Map new codes to the correct HTTP status when returned as API errors.
- Preserve existing error mappings for EPUB/media retry behavior.

### `python/pyproject.toml`
- Add the approved PDF extraction dependency for `pr-03` (**PyMuPDF**), with version pinning consistent with project conventions.
- Do not add frontend PDF.js dependencies here (`pr-06` owns frontend viewer path).

### `python/tests/test_upload.py`
- Add/adjust backend integration tests for `POST /media/{id}/ingest` confirming PDF rows route into the PDF lifecycle dispatch path with correct compat response fields.
- Add/adjust idempotency and non-creator/invalid-state coverage for PDF ingest confirm behavior as applicable to the final `pr-03` lifecycle dispatch design.
- Preserve existing EPUB ingest tests and response compatibility.

### `python/tests/test_media.py`
- Add backend integration tests for `POST /media/{id}/retry` covering PDF retry legal-state/creator guards, dispatch behavior, and deterministic failure cases.
- Add backend integration tests for `GET /media/{id}` PDF capability derivation using real persisted quote-text readiness (`pdf_quote_text_ready(media)`) (`can_read` vs `can_quote/can_search` split).
- Add retry/rebuild invalidation tests that verify PDF quote-match metadata + `prefix/suffix` invalidation semantics when text artifacts are rebuilt.

### `python/tests/test_libraries.py`
- Add backend integration tests proving library media listing capabilities for PDF reflect real quote-text readiness (`pdf_quote_text_ready(media)`) using the same predicate as `GET /media/{id}`.
- Preserve existing library listing visibility and ordering semantics.

### `python/tests/test_capabilities.py`
- Add/adjust unit tests only if `derive_capabilities(...)` semantics change or require additional PDF edge-case coverage (e.g., whitespace-only `plain_text` inputs delegated from callers).
- Keep tests pure (no DB I/O) per testing standards.

### `python/tests/test_pdf_ingest.py`
- Add unit/integration tests for PDF extraction domain logic:
  - normalization contract (`media.plain_text`)
  - page-span offset construction and contiguity validation
  - scanned/image-only no-text behavior
  - password-protected/encrypted deterministic failure classification
  - parser-specific (PyMuPDF) exception mapping to parser-agnostic `pdf_ingest` outcomes
  - row-local + lifecycle-level invariant enforcement split
- Include a sync test entry point path for deterministic extraction tests without Celery.

### `python/tests/test_pdf_ingest_task.py`
- Add task-level tests for `ingest_pdf` async lifecycle transitions, idempotent skip behavior, and unexpected-error fail-safe marking.
- Mirror the coverage style used in `python/tests/test_epub_ingest.py` while remaining PDF-specific.

---

## decision ledger

| question | decision | rationale | fallback/default |
|---|---|---|---|
| What lifecycle orchestration/module shape should `pr-03` use for PDF ingest confirm/retry and async extraction completion: extend `epub_lifecycle`, add a dedicated `pdf_lifecycle` + `ingest_pdf`, or introduce a generic cross-kind file-lifecycle framework now? | **Accepted (`S6-PR03-D01`)**: use a dedicated `python/nexus/services/pdf_lifecycle.py` + `python/nexus/services/pdf_ingest.py` + `python/nexus/tasks/ingest_pdf.py`, with thin route-level branching in `python/nexus/api/routes/media.py`. | Mirrors the proven EPUB split, keeps PDF and EPUB lifecycle policies isolated, and avoids premature generic file-lifecycle abstraction in a behavior-heavy PR. Reduces regression risk by leaving `epub_lifecycle` stable while shipping real PDF lifecycle behavior. | If implementation friction appears, factor small shared helpers after duplication is concrete, but keep distinct PDF lifecycle/task modules in `pr-03` (do not fold PDF policy into `epub_lifecycle`). |
| Which PDF extraction engine and deterministic error-classification contract should `pr-03` standardize for S6 (including password-protected vs renderable-no-text outcomes), and where should parser-specific behavior be isolated? | **Accepted (`S6-PR03-D02`)**: use **PyMuPDF** in `pr-03`, but isolate all parser-specific code and exception mapping inside `python/nexus/services/pdf_ingest.py`. Lifecycle/task code consumes only parser-agnostic typed outcomes (`success_with_text`, `success_no_text`, `protected_failure`, `extract_failure`). | Matches the S6 expectation of PyMuPDF while preserving the parser-agnostic contract at lifecycle/task/API layers. Prevents parser exception leakage, improves testability, and keeps future parser changes localized. | If implementation friction appears, keep PyMuPDF and parser isolation, and simplify outcome types internally while preserving parser-agnostic lifecycle/task behavior (do not let raw PyMuPDF exceptions propagate into lifecycle/routes). |
| What retry/rebuild mode contract should `pr-03` implement for PDF (`POST /media/{id}/retry` vs internal rebuild paths) so S6 invalidation rules and “no text rewrite on embedding/search retry” are both enforceable without breaking existing route compatibility? | **Accepted (`S6-PR03-D03`)**: keep public `POST /media/{id}/retry` request/response compatibility unchanged and infer user-facing retry behavior from lifecycle/failure context; implement explicit internal `pdf_lifecycle` rebuild/repair helper(s) for text-artifact rewrites/operator rebuild paths. Public retry paths must preserve S6 invalidation rules and embedding/search no-rewrite semantics via mode-specific lifecycle behavior, not via a new API parameter. | Preserves route compatibility and client simplicity while enforcing S6’s two retry semantics cleanly. Separates user-facing retries from operator/maintenance rebuild workflows and keeps invalidation sequencing explicit/testable in lifecycle helpers. | If implementation friction appears, keep public retry compatibility and internal rebuild helpers, and narrow the public retry matrix; do not add a public retry-mode parameter in `pr-03` without a roadmap/spec change. |
| What is the public retry policy for password-protected/encrypted PDF failures in S6 (`E_PDF_PASSWORD_REQUIRED`) given v1 has no password flow? | **Accepted (`S6-PR03-D04`)**: treat password-protected/encrypted PDF failures as terminal for public `POST /media/{id}/retry` in S6 (`409 E_RETRY_NOT_ALLOWED`). No password prompt, credential retry, or hidden redispatch for the same protected file in v1. | Aligns with explicit S6 constraints (no password flow), avoids guaranteed-repeat failures and retry churn, and matches the terminal-failure precedent used by EPUB (`E_ARCHIVE_UNSAFE`). Keeps public retry behavior deterministic and honest. | If future slices add a password flow, revisit this policy explicitly in L2/L3 and adjust public retry behavior with a reviewed contract change; do not loosen `pr-03` terminal handling ad hoc. |
| How should `pr-03` derive the PDF capability gate passed to `derive_capabilities(...)` so `GET /media/{id}` / library-list quote/search behavior matches full S6 `pdf_quote_text_ready(media)` semantics (plain text + page_count + contiguous/full `pdf_page_text_spans`), given the current seam uses a boolean placeholder named `has_plain_text`? | **Accepted (`S6-PR03-D05`)**: introduce an explicit PDF quote-readiness capability seam in `derive_capabilities(...)` (recommended parameter name: `pdf_quote_text_ready`) and compute it in callers from a DB-backed full quote-readiness predicate. Do not use raw plain-text presence alone for PDF quote/search gating. | Aligns code with S6’s actual readiness model, prevents premature `can_quote/can_search=true` on incomplete page-span coverage, and avoids a misleading long-lived parameter name. Preserves the pure function boundary while making the capability input semantically correct. | If implementation friction appears, keep `derive_capabilities(...)` pure and preserve explicit quote-readiness semantics even if a temporary compatibility alias is needed internally; do not overload `has_plain_text` to mean full quote readiness long term. |
| Where should the shared DB-backed PDF quote-readiness predicate helper(s) live so `python/nexus/services/media.py` and `python/nexus/services/libraries.py` can reuse one implementation without circular imports or duplicated SQL? | **Accepted (`S6-PR03-D06`)**: use a dedicated `python/nexus/services/pdf_readiness.py` module with single-media and batch quote-readiness helpers reused by `media.py` and `libraries.py`. Keep `python/nexus/services/capabilities.py` pure. | Centralizes a correctness-critical predicate in one DB-backed seam, avoids duplicated SQL and drift between detail/list surfaces, preserves `derive_capabilities(...)` purity, and keeps service layering cleaner than importing broad service modules into each other. Supports batched list readiness derivation without N+1 behavior. | If implementation friction appears, keep one shared readiness seam and preserve batch/list support; do not duplicate quote-readiness SQL in `media.py` and `libraries.py` or move DB access into `capabilities.py`. |
| How should `python/nexus/services/pdf_readiness.py` implement `pdf_quote_text_ready(media)` for detail and list surfaces: revalidate full page-span contiguity/coverage on every read, or rely on `pr-03` write-time lifecycle validation with lighter read-time checks? | **Accepted (`S6-PR03-D07`)**: enforce full page-span invariants at write time in `pdf_ingest` / `pdf_lifecycle`, and use a shared lightweight DB predicate in `pdf_readiness.py` for detail/list capability gating with fail-closed handling and anomaly logging on impossible states. Do not perform full contiguity revalidation on list reads. | Preserves correctness where invariants are authored (write path), keeps capability reads scalable for list endpoints, and avoids duplicating heavy contiguity logic in read-time SQL. Fail-closed behavior protects user-facing capability truth if data integrity is unexpectedly violated. | If implementation friction appears, preserve the write-time invariant enforcement boundary and a shared read predicate seam; do not duplicate readiness SQL per caller or reintroduce expensive per-row contiguity checks in list reads. |
| What is the `pr-03` lifecycle outcome policy when PDF extraction yields text but `pdf_page_text_spans` lifecycle invariants fail (incomplete page set, non-contiguous offsets, impossible spans): fail extraction or degrade to readable/no-quote? | **Accepted (`S6-PR03-D08`)**: treat text-bearing extraction outcomes with page-span lifecycle invariant failures as deterministic extract failures (fail closed), not readable/no-quote degrade paths. Reserve degrade-to-readable for explicit `success_no_text` scanned/image-only outcomes. | Preserves trust in the `pdf_quote_text_ready(media)` model and the `D07` lightweight read predicate by ensuring invalid indexing artifacts do not silently enter readable quote/search readiness inputs. Keeps indexing integrity failures explicit, retryable, and operationally visible. | If implementation friction appears, preserve fail-closed extract failure semantics for text-bearing page-span invariant failures; do not silently degrade them to readable/no-quote without an explicit L2/L3 contract change. |
| What is the `pr-03` idempotency policy for repeated `POST /media/{id}/ingest` on a non-duplicate PDF after initial dispatch (e.g., already `extracting`, `ready_for_reading`, `failed`): no-op response, redispatch, or conflict? | **Accepted (`S6-PR03-D09`)**: make PDF ingest-confirm idempotent and no-redispatch for non-duplicate, non-pending media. Only `pending` may transition to `extracting` and enqueue extraction; other states return the compat response with current `processing_status` and `ingest_enqueued=false` without lifecycle mutation. | Prevents duplicate extraction job churn, makes client retries/timeouts safe, and aligns PDF ingest-confirm behavior with the established EPUB lifecycle orchestration pattern while preserving route compatibility. | If implementation friction appears, preserve no-redispatch idempotence and compat response shape for non-pending media; do not introduce redispatch-on-repeat or conflict responses without an explicit L2/L3 contract change. |
| How should `python/nexus/services/pdf_readiness.py` integrate with `python/nexus/services/libraries.py` for library list capability gating: inline readiness SQL in the main list query, per-row helper calls, or a separate batched readiness query over the paged media IDs? | **Accepted (`S6-PR03-D10`)**: use a separate batched readiness query in `pdf_readiness.py` over the already-paged media IDs returned by `libraries.py`, then merge readiness flags in memory before `derive_capabilities(...)`. Avoid per-row DB calls and avoid overloading the main list query with complex readiness aggregates. | Preserves list pagination/order semantics, avoids N+1 behavior, keeps readiness SQL centralized in `pdf_readiness.py`, and keeps the main library list query maintainable. Provides a clean reusable seam for future list/detail consumers while honoring `D06/D07`. | If implementation friction appears, preserve one shared batch readiness seam and list/detail consistency; do not fall back to per-row readiness DB calls or duplicate readiness SQL in `libraries.py`. |
| What exact public retry inference matrix should `pr-03` use for failed PDF media (`failure_stage` / `last_error_code` -> embedding-only retry vs text-rebuild retry vs terminal disallow) while preserving route compatibility and S6 no-rewrite rules? | **Accepted (`S6-PR03-D11`)**: use an explicit precedence-ordered inference matrix for public PDF retry: (1) non-`failed` -> `E_RETRY_INVALID_STATE`; (2) `last_error_code=E_PDF_PASSWORD_REQUIRED` -> terminal disallow (`E_RETRY_NOT_ALLOWED`); (3) `failure_stage='embed'` -> embedding/search-only retry path (no text rewrite); (4) `failure_stage in {'upload','extract','other'}` -> text-rebuild/extraction retry path; (5) impossible PDF `failure_stage='transcribe'` -> fail closed/internal integrity error. | Makes retry behavior deterministic and testable, enforces S6 no-text-rewrite semantics for embed/search failures, preserves terminal password behavior precedence, and handles impossible PDF failure-stage states loudly instead of silently coercing them. | If implementation friction appears, preserve the precedence order and the `embed` vs extraction-rebuild split; do not collapse all failed PDF retries into extraction rebuild or silently coerce impossible PDF `failure_stage` values. |
| How should `pr-03` classify and persist state when the shared embedding/post-extract handoff fails synchronously after successful PDF extraction (before downstream embedding work runs)? | **Accepted (`S6-PR03-D12`)**: treat synchronous embedding handoff/dispatch failures after successful extraction as embed-stage failures (`failure_stage='embed'`) and preserve the successfully persisted PDF extraction artifacts (`media.page_count`, `media.plain_text`, `pdf_page_text_spans`). Do not reclassify as extract failure or roll back extraction artifacts solely because the embedding handoff failed. | Preserves the correctness of the `D11` public retry inference matrix (`failure_stage='embed'` => embedding-only retry), avoids unnecessary extraction rework, and keeps extraction success distinct from embedding dispatch failure. Maintains clear stage attribution for operations and debugging. | If implementation friction appears, preserve embed-stage classification and extracted-artifact preservation for synchronous handoff failures; do not silently collapse these failures into extract-stage failures without an explicit L2/L3 contract change. |

---

## traceability matrix

| l3 acceptance item | deliverable(s) | test(s) |
|---|---|---|
| PDFs uploaded through the existing upload flow are recognized and routed into the S6 PDF processing lifecycle with the defined readiness/failure transitions. | `python/nexus/api/routes/media.py`; `python/nexus/services/pdf_lifecycle.py`; `python/tests/test_upload.py` | `test_pr03_ingest_pdf_confirm_routes_to_pdf_lifecycle_and_dispatches`; `test_pr03_ingest_pdf_confirm_preserves_compat_response_fields`; `test_pr03_ingest_pdf_confirm_non_creator_forbidden`; `test_pr03_ingest_pdf_confirm_repeat_call_idempotent_without_redispatch` |
| PDF processing can produce `page_count`, normalized `media.plain_text`, and contiguous page-span indexing for quote/search readiness. | `python/nexus/services/pdf_ingest.py`; `python/nexus/tasks/ingest_pdf.py`; `python/tests/test_pdf_ingest.py`; `python/tests/test_pdf_ingest_task.py` | `test_pr03_pdf_ingest_extracts_page_count_plain_text_and_page_spans`; `test_pr03_pdf_plain_text_normalization_matches_s6_contract`; `test_pr03_ingest_pdf_task_marks_ready_for_reading_on_success` |
| Successful PDF extraction hands off to the existing embedding pipeline / post-extract path so downstream embedding failures use `failure_stage='embed'` semantics (without redesigning the embedding pipeline in `pr-03`). | `python/nexus/tasks/ingest_pdf.py`; `python/nexus/services/pdf_lifecycle.py`; `python/tests/test_pdf_ingest_task.py`; `python/tests/test_media.py` | `test_pr03_ingest_pdf_task_hands_off_to_embedding_pipeline_after_successful_extraction`; `test_pr03_ingest_pdf_task_handoff_failure_marks_failed_with_embed_stage_and_preserves_extracted_artifacts`; `test_pr03_retry_pdf_embed_failure_uses_embedding_only_retry_inference_path` |
| `pr-03` enforces/validates contiguous/full-page-set `pdf_page_text_spans` lifecycle invariants (beyond the row-local schema checks introduced in `pr-01`) before quote-capable readiness is considered satisfied. | `python/nexus/services/pdf_ingest.py`; `python/nexus/services/pdf_lifecycle.py`; `python/tests/test_pdf_ingest.py`; `python/tests/test_media.py` | `test_pr03_pdf_ingest_fails_extract_when_page_spans_not_contiguous_after_text_extraction`; `test_pr03_pdf_ingest_fails_extract_when_page_span_set_incomplete_after_text_extraction`; `test_pr03_pdf_ingest_text_bearing_invariant_failure_rolls_back_partial_text_artifacts`; `test_pr03_get_media_pdf_quote_search_capabilities_require_full_text_readiness` |
| `pr-03` owns lifecycle/invalidation validation for PDF quote-match metadata on `highlight_pdf_anchors` beyond the row-local schema checks introduced in `pr-01`. | `python/nexus/services/pdf_lifecycle.py`; `python/nexus/services/pdf_ingest.py`; `python/tests/test_media.py`; `python/tests/test_pdf_ingest.py` | `test_pr03_pdf_text_rebuild_invalidates_pdf_quote_match_metadata_and_prefix_suffix`; `test_pr03_embedding_retry_does_not_rewrite_pdf_text_artifacts_or_invalidate_matches`; `test_pr03_pdf_invalidation_preserves_geometry_and_exact_text` |
| `ready_for_reading` and PDF quote/search readiness are correctly split per S6 lifecycle rules. | `python/nexus/services/pdf_ingest.py`; `python/nexus/tasks/ingest_pdf.py`; `python/nexus/services/media.py`; `python/nexus/services/libraries.py`; `python/tests/test_media.py`; `python/tests/test_libraries.py`; `python/tests/test_capabilities.py` | `test_pr03_get_media_pdf_can_read_before_can_quote_when_plain_text_not_ready`; `test_pr03_library_list_pdf_capabilities_match_detail_readiness_split`; `test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input` |
| Scanned/image-only and password-protected PDF behaviors follow S6 deterministic degrade/fail semantics. | `python/nexus/services/pdf_ingest.py`; `python/nexus/tasks/ingest_pdf.py`; `python/nexus/errors.py`; `python/tests/test_pdf_ingest.py`; `python/tests/test_media.py` | `test_pr03_pdf_ingest_scanned_or_image_only_marks_readable_without_quote_text`; `test_pr03_pdf_ingest_password_protected_fails_with_deterministic_error_code`; `test_pr03_get_media_pdf_scanned_visual_read_only_capabilities`; `test_pr03_retry_pdf_password_protected_terminal_behavior_matches_policy` |
| Retry/rebuild paths honor S6 invalidation rules for PDF quote-match metadata and do not rewrite text artifacts on embedding/search-only retries. | `python/nexus/services/pdf_lifecycle.py`; `python/nexus/services/pdf_ingest.py`; `python/nexus/api/routes/media.py`; `python/tests/test_media.py` | `test_pr03_retry_pdf_route_preserves_compat_response_shape_without_mode_parameter`; `test_pr03_retry_pdf_failed_resets_and_dispatches_text_rebuild_path`; `test_pr03_retry_pdf_embedding_only_path_does_not_rewrite_plain_text_or_page_spans`; `test_pr03_retry_pdf_text_rebuild_path_invalidates_before_rewrite`; `test_pr03_retry_pdf_embed_failure_uses_embedding_only_retry_inference_path`; `test_pr03_retry_pdf_transcribe_failure_stage_fails_closed_as_internal_integrity_error` |
| `GET /media/{id}` capability derivation reflects real PDF quote-text readiness (`pdf_quote_text_ready(media)`) via an explicit capability seam (not raw plain-text presence). | `python/nexus/services/media.py`; `python/nexus/services/libraries.py`; `python/nexus/services/capabilities.py`; `python/nexus/services/pdf_readiness.py`; `python/tests/test_media.py`; `python/tests/test_libraries.py`; `python/tests/test_capabilities.py` | `test_pr03_get_media_pdf_capabilities_use_real_quote_text_readiness_predicate`; `test_pr03_get_media_pdf_capabilities_do_not_flip_quote_search_on_plain_text_without_full_page_span_readiness`; `test_pr03_library_list_pdf_capabilities_use_same_quote_text_readiness_predicate_as_detail`; `test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input` |

---

## acceptance tests

### file: `python/tests/test_upload.py`

**test: `test_pr03_ingest_pdf_confirm_routes_to_pdf_lifecycle_and_dispatches`**
- input: upload a valid PDF via existing upload init flow, then call `POST /media/{id}/ingest`.
- output: response preserves ingest compat fields and the PDF lifecycle dispatch path is used (`processing_status='extracting'`, `ingest_enqueued=true`) without affecting EPUB behavior.

**test: `test_pr03_ingest_pdf_confirm_preserves_compat_response_fields`**
- input: confirm ingest for a non-duplicate PDF upload.
- output: response shape remains `{media_id, duplicate, processing_status, ingest_enqueued}` and existing clients remain compatible.

**test: `test_pr03_ingest_pdf_confirm_non_creator_forbidden`**
- input: user B attempts to confirm ingest for a PDF upload created by user A.
- output: request is rejected with existing creator-only semantics.

**test: `test_pr03_ingest_pdf_confirm_repeat_call_idempotent_without_redispatch`**
- input: call `POST /media/{id}/ingest` twice for the same PDF after first dispatch.
- output: second call returns the current `processing_status`, `ingest_enqueued=false`, preserves the compat response shape, and does not enqueue a second extraction task or mutate lifecycle fields.

### file: `python/tests/test_media.py`

**test: `test_pr03_retry_pdf_failed_resets_and_dispatches_text_rebuild_path`**
- input: a creator retries a failed PDF whose retry inference matrix selects the text-rebuild/extraction path (`failure_stage in {'upload','extract','other'}` and not terminal password-protected).
- output: lifecycle state resets to `extracting`, dispatch occurs once on the extraction/text-rebuild path, and response preserves retry compat fields.

**test: `test_pr03_retry_pdf_route_preserves_compat_response_shape_without_mode_parameter`**
- input: call public `POST /media/{id}/retry` for a PDF media in a legal retry state.
- output: request uses no retry-mode parameter/body and response remains `RetryResponse`-compatible while lifecycle behavior is inferred by the service.

**test: `test_pr03_retry_pdf_embedding_only_path_does_not_rewrite_plain_text_or_page_spans`**
- input: retry a failed PDF with `failure_stage='embed'` (or invoke the equivalent internal embedding/search-only retry service path) for a media with existing text artifacts.
- output: retry dispatch uses the embedding/search-only path; `media.plain_text` and `pdf_page_text_spans` are unchanged and quote-match metadata is not invalidated solely for this retry.

**test: `test_pr03_retry_pdf_text_rebuild_path_invalidates_before_rewrite`**
- input: invoke a PDF text rebuild/repair retry path on a media with existing PDF highlight quote-match metadata.
- output: quote-match metadata and PDF `prefix/suffix` are invalidated before new text artifacts are written, preserving S6 stale-offset safety.

**test: `test_pr03_pdf_text_rebuild_invalidates_pdf_quote_match_metadata_and_prefix_suffix`**
- input: a PDF with highlights has persisted `plain_text_match_*` and non-empty `prefix/suffix`; run a text-artifact rebuild path.
- output: `highlight_pdf_anchors.plain_text_match_status` resets to `pending`, offsets/version clear, `prefix/suffix` clear, and geometry/`exact` remain unchanged.

**test: `test_pr03_pdf_invalidation_preserves_geometry_and_exact_text`**
- input: rebuild PDF text artifacts for a media with persisted PDF highlights.
- output: invalidation mutates only quote-match metadata + `prefix/suffix`; geometry subtype/quads and `highlight.exact` are preserved.

**test: `test_pr03_get_media_pdf_can_read_before_can_quote_when_plain_text_not_ready`**
- input: a PDF media row with file present and readable lifecycle state but no quote-ready `plain_text`/page-span coverage.
- output: `GET /media/{id}` reports `can_read=true`, `can_quote=false`, `can_search=false`.

**test: `test_pr03_get_media_pdf_quote_search_capabilities_require_full_text_readiness`**
- input: compare PDF media variants with partial/incomplete `pdf_page_text_spans` vs full contiguous page-span coverage and non-empty normalized `plain_text`.
- output: `can_quote/can_search` become true only for the fully quote-ready variant.

**test: `test_pr03_get_media_pdf_capabilities_use_real_quote_text_readiness_predicate`**
- input: `GET /media/{id}` on PDFs across readiness states (no plain text, plain text only, missing/incomplete `pdf_page_text_spans`, full quote-ready artifacts).
- output: caller computes and passes a real DB-backed PDF quote-readiness boolean to `derive_capabilities(...)`, not a hardcoded placeholder.

**test: `test_pr03_get_media_pdf_capabilities_do_not_flip_quote_search_on_plain_text_without_full_page_span_readiness`**
- input: PDF media with non-empty normalized `plain_text` but missing/partial/non-contiguous `pdf_page_text_spans`.
- output: `can_quote/can_search` remain false because the full `pdf_quote_text_ready(media)` predicate is not satisfied.

**test: `test_pr03_get_media_pdf_scanned_visual_read_only_capabilities`**
- input: renderable/scanned-like PDF outcome with readable file and empty/absent normalized text.
- output: `can_read=true`, `can_highlight=true` (media-level), `can_quote=false`, `can_search=false`, consistent with S6 visual-read-only semantics.

**test: `test_pr03_retry_pdf_password_protected_terminal_behavior_matches_policy`**
- input: retry a password-protected/encrypted PDF after deterministic terminal failure in S6.
- output: public retry is disallowed with deterministic conflict semantics (`E_RETRY_NOT_ALLOWED`) and no extraction redispatch occurs.

**test: `test_pr03_retry_pdf_password_protected_returns_retry_not_allowed_without_dispatch`**
- input: call public `POST /media/{id}/retry` on a failed PDF whose `last_error_code` is `E_PDF_PASSWORD_REQUIRED`.
- output: route returns deterministic `409 E_RETRY_NOT_ALLOWED` and does not dispatch extraction.

**test: `test_pr03_retry_pdf_embed_failure_uses_embedding_only_retry_inference_path`**
- input: call public `POST /media/{id}/retry` on a failed PDF with `failure_stage='embed'` and a non-terminal `last_error_code`.
- output: the public retry inference matrix selects the embedding/search-only retry path (no text-artifact rewrite path), response remains `RetryResponse`-compatible, and no extraction/text-rebuild dispatch occurs.

**test: `test_pr03_retry_pdf_transcribe_failure_stage_fails_closed_as_internal_integrity_error`**
- input: call public `POST /media/{id}/retry` on a failed PDF in an impossible state (`failure_stage='transcribe'`).
- output: retry fails closed with internal integrity error behavior (no dispatch, no silent coercion to another retry mode) and logs an integrity anomaly.

### file: `python/tests/test_libraries.py`

**test: `test_pr03_library_list_pdf_capabilities_use_same_quote_text_readiness_predicate_as_detail`**
- input: list library media containing PDFs across quote-readiness states and compare with `GET /media/{id}` for the same rows.
- output: library-list capabilities use the same DB-backed PDF quote-readiness predicate as detail view and preserve list visibility/order semantics.

**test: `test_pr03_library_list_pdf_capabilities_match_detail_readiness_split`**
- input: compare `GET /libraries/{id}/media` and `GET /media/{id}` for the same PDF media in readable-but-not-quote-ready and quote-ready states.
- output: capability flags are consistent across list and detail surfaces for PDF read-vs-quote split semantics.

### file: `python/tests/test_capabilities.py`

**test: `test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input`**
- input: call `derive_capabilities(kind='pdf', ..., pdf_quote_text_ready=False/True)` with otherwise identical inputs.
- output: PDF `can_quote/can_search` follow the explicit quote-readiness input, while `can_read` remains file-based.

### file: `python/tests/test_pdf_ingest.py`

**test: `test_pr03_pdf_ingest_extracts_page_count_plain_text_and_page_spans`**
- input: run PDF extraction domain service on a valid text-based PDF fixture via sync helper.
- output: persists/returns `page_count`, normalized `media.plain_text`, and one `pdf_page_text_spans` row per page with valid offsets.

**test: `test_pr03_pdf_plain_text_normalization_matches_s6_contract`**
- input: extraction output containing mixed line endings, NBSPs, repeated spaces/newlines, and page separators.
- output: persisted/returned `plain_text` matches S6 normalization rules exactly and span offsets reference the normalized text.

**test: `test_pr03_pdf_ingest_fails_extract_when_page_spans_not_contiguous_after_text_extraction`**
- input: force a page-span construction anomaly/non-contiguous offsets in the PDF ingest domain logic test seam.
- output: `pr-03` treats the extraction as deterministic extract failure (fail closed), does not expose a readable/no-quote degrade path for this text-bearing invariant failure, and records the approved extract-stage failure semantics.

**test: `test_pr03_pdf_ingest_fails_extract_when_page_span_set_incomplete_after_text_extraction`**
- input: simulate missing page-span rows for a multi-page PDF.
- output: `pr-03` treats the extraction as deterministic extract failure (fail closed) and does not silently degrade this text-bearing indexing integrity error to readable/no-quote.

**test: `test_pr03_pdf_ingest_text_bearing_invariant_failure_rolls_back_partial_text_artifacts`**
- input: force a text-bearing page-span invariant failure after provisional extraction artifacts are produced within the `pdf_ingest` persistence transaction.
- output: the extraction attempt fails closed and leaves no partial persisted `media.page_count`, `media.plain_text`, or `pdf_page_text_spans` rows from the failed attempt (transaction rollback / equivalent atomicity guarantee).

**test: `test_pr03_pdf_ingest_scanned_or_image_only_marks_readable_without_quote_text`**
- input: PDF fixture/path that is renderable but produces no usable normalized text.
- output: extraction result supports `ready_for_reading` semantics with `plain_text` absent/empty and quote/search readiness disabled.

**test: `test_pr03_pdf_ingest_password_protected_fails_with_deterministic_error_code`**
- input: password-protected/encrypted PDF fixture/path in v1 without password flow.
- output: extraction returns deterministic failure classification (`E_PDF_PASSWORD_REQUIRED`).

**test: `test_pr03_pdf_ingest_maps_pymupdf_parser_exceptions_to_parser_agnostic_outcomes`**
- input: inject representative PyMuPDF/parser exceptions in `pdf_ingest` test seams (protected PDF, generic open/parse failure).
- output: `pdf_ingest` maps them to the approved parser-agnostic typed outcomes without leaking raw parser exceptions to lifecycle callers.

**test: `test_pr03_embedding_retry_does_not_rewrite_pdf_text_artifacts_or_invalidate_matches`**
- input: invoke the internal embedding/search-only retry/rebuild service path on a PDF with existing text artifacts and quote-match metadata.
- output: no text-artifact rewrite occurs and quote-match metadata remains intact.

### file: `python/tests/test_pdf_ingest_task.py`

**test: `test_pr03_ingest_pdf_task_marks_ready_for_reading_on_success`**
- input: run `ingest_pdf` task for a media row in `extracting` with a successful extraction result.
- output: task transitions media to `ready_for_reading`, persists lifecycle fields correctly, and logs success.

**test: `test_pr03_ingest_pdf_task_hands_off_to_embedding_pipeline_after_successful_extraction`**
- input: run `ingest_pdf` task for a media row in `extracting` with a successful extraction result and the shared embedding/post-extract handoff path available.
- output: task invokes the existing embedding pipeline/post-extract handoff exactly once (no PDF-specific embedding fork), preserving `failure_stage='embed'` semantics for downstream failures.

**test: `test_pr03_ingest_pdf_task_handoff_failure_marks_failed_with_embed_stage_and_preserves_extracted_artifacts`**
- input: run `ingest_pdf` task where PDF extraction succeeds and persists artifacts, but the shared embedding/post-extract handoff raises synchronously before downstream embedding work is enqueued.
- output: task marks `failed` with `failure_stage='embed'` (not `extract`), preserves the successfully persisted extraction artifacts (`page_count`, `plain_text`, `pdf_page_text_spans`), and logs an embed-stage handoff failure suitable for the `D11` retry inference matrix.

**test: `test_pr03_ingest_pdf_task_marks_failed_on_extraction_error`**
- input: run `ingest_pdf` task with a deterministic PDF extraction error (e.g., password-protected classification).
- output: task marks `failed`, sets `failure_stage='extract'`, persists deterministic `last_error_code`, and logs failure.

**test: `test_pr03_ingest_pdf_task_idempotent_on_missing_or_nonextracting_media`**
- input: run `ingest_pdf` for missing media and for media not in `extracting`.
- output: task exits with skip semantics and no state corruption.

**test: `test_pr03_ingest_pdf_task_unexpected_error_marks_failed_when_possible`**
- input: inject an unexpected exception during PDF extraction execution.
- output: task rolls back and marks `failed` with a generic ingest failure code when the media is still `extracting`.

---

## non-goals
- does not add PDF highlight CRUD/list/update APIs (owned by `pr-04`)
- does not implement PDF geometry canonicalization, fingerprinting, duplicate detection, or PDF highlight write-time validation (owned by `pr-04`)
- does not implement PDF quote-to-chat nearby-context rendering or PDF match algorithm usage semantics beyond readiness/invalidation prerequisites (owned by `pr-05`)
- does not ship the frontend PDF viewer/read path or PDF.js integration (owned by `pr-06`)
- does not ship frontend PDF highlighting overlays or linked-items pane PDF adapter behavior (owned by `pr-07`)
- does not implement artifact-generation version binding for PDF quote-match metadata (S6-D06 chose invalidation+recompute instead)
- does not add a public retry-mode parameter or a second public PDF retry endpoint in `pr-03`
- does not perform hidden repair writes in read-only highlight/context/send-message paths (owned by `pr-02` kernel rules)
- does not overload raw plain-text presence as the long-term PDF quote/search capability contract in `pr-03`
- does not implement a server-side dual-parser/fallback PDF extraction architecture in `pr-03` (PyMuPDF-only backend extraction)
- does not add PDF metadata/XMP/version extraction or persistence contract behavior in `pr-03`

---

## constraints
- only touch files listed in deliverables unless the spec is revised.
- preserve existing ingest/retry route contracts (`IngestResponse`, `RetryResponse`) and no-existence-leak semantics.
- preserve existing EPUB lifecycle behavior while adding PDF lifecycle support.
- `pr-03` may rely on `pr-01` schema/model foundation only; do not require unmerged `pr-04+` behavior.
- enforce S6 PDF normalization + `pdf_page_text_spans` lifecycle invariants before quote-capable readiness is treated as satisfied.
- text-bearing page-span invariant failures must not leave partial persisted PDF quote-text artifacts from the failed extraction attempt.
- implement S6 invalidation+recompute posture (`S6-D06`) without adding artifact-generation version columns.
- keep `derive_capabilities(...)` pure (no DB access); caller services own real PDF quote-readiness boolean derivation for capability gating.
- keep password/scanned behavior deterministic and parser-specific implementation details behind `pdf_ingest` domain service.
- if a non-fatal scanned/no-text diagnostic (`E_PDF_TEXT_UNAVAILABLE`) is recorded, it must not alter S6 readable/no-quote degrade semantics or public ingest/retry error mappings.

---

## boundaries (for ai implementers)

**do**:
- mirror the established EPUB pattern (lifecycle orchestration service + extraction domain service + async task) unless a reviewed decision explicitly selects another shape.
- centralize PDF text normalization, page-span construction, and lifecycle-level span validation in `pdf_ingest` / `pdf_lifecycle`, not in routes.
- make `GET /media/{id}` and library-list capability derivation use one shared DB-backed PDF quote-readiness predicate (`pdf_quote_text_ready(media)`) consistently.
- implement set-based invalidation of PDF quote-match metadata + `prefix/suffix` for text-artifact rebuild paths before rewrites occur.
- add deterministic task-level and service-level tests for scanned/protected/retry edge cases.
- make the successful PDF extraction -> embedding handoff explicit and test it without introducing a PDF-specific embedding pipeline fork.
- classify synchronous post-extract embedding handoff/dispatch failures as embed-stage failures (`failure_stage='embed'`) and preserve already-persisted extraction artifacts for correct retry semantics.

**do not**:
- add PDF highlight routes, PDF quote rendering, or frontend PDF viewer behavior.
- duplicate upload hashing/dedup logic already owned by `python/nexus/services/upload.py` unless explicitly required.
- collapse PDF lifecycle rules into ad hoc route branches without a dedicated lifecycle service.
- silently weaken S6 page-span coverage/contiguity requirements for quote-capable readiness.
- rewrite text artifacts during embedding/search-only retries.

---

## open questions + temporary defaults

- None.

---

## checklist
- [x] every l3 acceptance bullet is in traceability matrix
- [x] every traceability row has at least one test
- [x] every behavior-changing decision has assertions
- [ ] only scoped files are touched (implementation-time verification; not a spec-drafting completeness check)
- [x] non-goals are explicit and enforced
