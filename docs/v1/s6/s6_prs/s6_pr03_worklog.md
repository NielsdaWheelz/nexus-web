# S6 PR-03 L4 Spec Worklog

## Evidence Log

- Reviewed `pr-03` roadmap entry and acceptance bullets in `docs/v1/s6/s6_pr_roadmap.md` (PDF processing/readiness, text artifacts, invalidation, capabilities, scanned/protected behavior).
- Reviewed S6 L2 spec sections governing PDF text normalization, `pdf_page_text_spans`, PDF quote-match invalidation, processing lifecycle, and `GET /media/{id}` PDF capability extensions (`docs/v1/s6/s6_spec.md` Sections `2.1`, `2.2`, `2.4`, `3.1`, `4.1`, `6`, `7`).
- Reviewed accepted S6 decisions relevant to `pr-03` (`S6-D03`, `S6-D05`, `S6-D06`) in `docs/v1/s6/s6_spec_decisions.md`.
- Reviewed `pr-01` implementation report for actual schema/model artifacts and constraint/index names used by `pr-03` (`docs/v1/s6/s6_prs/s6_pr01_implementation_report.md`).
- Reviewed L4 template/process requirements in `docs/v1/sdlc/L4-pr-spec.md`.

## Current Codebase Findings (pre-pr-03)

- Upload init already supports PDF/EPUB file kinds and persists `media` + `media_file` rows (`python/nexus/services/upload.py`), but there is no PDF extraction/lifecycle service/task implementation yet.
- `POST /media/{id}/ingest` and `POST /media/{id}/retry` currently delegate to EPUB-specific lifecycle orchestration (`python/nexus/api/routes/media.py`, `python/nexus/services/epub_lifecycle.py`).
- EPUB uses the pattern `epub_lifecycle` (route orchestration) + `epub_ingest` (domain extraction) + `ingest_epub` task (async completion state transitions), which is the closest `pr-03` implementation reference.
- `derive_capabilities(...)` already contains the S6 PDF read-vs-quote split and `has_plain_text` hook, but `python/nexus/services/media.py` and `python/nexus/services/libraries.py` still pass `has_plain_text=False` placeholders.
- `pr-01` schema/model foundation is present in `python/nexus/db/models.py`:
  - `Media.plain_text`, `Media.page_count`
  - `PdfPageTextSpan`
  - `HighlightPdfAnchor.plain_text_match_*` (invalidation targets)
- No PDF parser dependency or PDF extraction module is currently present in the backend codebase.

## Drafting Progress

- Created `docs/v1/s6/s6_prs/s6_pr03_spec.md` L4 skeleton with required sections.
- Seeded deliverables from real code seams (upload/EPUB lifecycle/task, capabilities callers, `pr-01` schema artifacts).
- Seeded traceability matrix for all 9 `pr-03` L3 acceptance bullets with concrete candidate test names and file paths.
- Seeded acceptance-test scaffolding across `test_upload.py`, `test_media.py`, `test_libraries.py`, `test_capabilities.py`, `test_pdf_ingest.py`, and `test_pdf_ingest_task.py`.
- Resolved `S6-PR03-D01` (dedicated PDF lifecycle/domain/task split with thin route branching; no premature generic file-lifecycle abstraction) and prepared roadmap carry-forward notes.
- Resolved `S6-PR03-D02` (PyMuPDF implementation isolated behind parser-agnostic `pdf_ingest` outcomes and parser-specific exception mapping in `pdf_ingest`) and prepared roadmap carry-forward notes.
- Resolved `S6-PR03-D03` (public retry route compatibility preserved; inferred user-facing retry mode behavior + explicit internal rebuild/repair helpers for text-artifact rewrites) and prepared roadmap carry-forward notes.
- Resolved `S6-PR03-D04` (password-protected/encrypted PDF failures are terminal for public retry in S6; `409 E_RETRY_NOT_ALLOWED`) and prepared roadmap carry-forward notes.
- Resolved `S6-PR03-D05` (explicit `pdf_quote_text_ready` capability seam; no overload of raw plain-text presence for PDF quote/search gating) and patched L2/L3/L4 wording for readiness terminology consistency.
- Resolved `S6-PR03-D06` (shared DB-backed PDF quote-readiness predicate helper placement): `pr-03` uses a dedicated `python/nexus/services/pdf_readiness.py` module with single-media and batch helpers reused by `python/nexus/services/media.py` and `python/nexus/services/libraries.py`, while keeping `python/nexus/services/capabilities.py` pure.
- Resolved `S6-PR03-D07` (exact `pdf_readiness.py` predicate strategy): `pr-03` enforces full page-span invariants at write time in `pdf_ingest` / `pdf_lifecycle`, and uses a lightweight shared `pdf_readiness.py` predicate for detail/list capability gating with fail-closed anomaly logging on impossible states (no full contiguity revalidation on list reads).
- Resolved `S6-PR03-D08` (lifecycle outcome policy for text-bearing extraction results that fail `pdf_page_text_spans` invariants): fail closed as deterministic extract failures; degrade-to-readable remains reserved for explicit no-text/scanned outcomes.
- Resolved `S6-PR03-D09` (repeated `POST /media/{id}/ingest` idempotency/redispatch policy): PDF ingest-confirm is idempotent/no-redispatch for non-duplicate non-pending states, returning compat response shape with current `processing_status` and `ingest_enqueued=false`.
- Resolved `S6-PR03-D10` (library-list batch integration strategy for shared `pdf_readiness.py`): use a separate batched readiness query over paged media IDs from `libraries.py`, then merge readiness flags in memory before `derive_capabilities(...)`.
- Resolved `S6-PR03-D11` (exact public retry inference matrix for failed PDF media): precedence-ordered mapping with terminal password disallow, `failure_stage='embed'` embedding-only retry, `upload|extract|other` extraction/text-rebuild retry, and fail-closed handling for impossible PDF `failure_stage='transcribe'`.

## Open Decision Queue

- None (closed).

## Hardening Notes

- Final drafting hardening pass completed after `S6-PR03-D11`: no open decisions remain, `open questions + temporary defaults` is empty, and stale decision-placeholder wording was removed from the `pr-03` spec.
- Traceability/test alignment tightened to include `D11` retry-matrix behavior assertions (`embed` retry inference path and impossible PDF `failure_stage='transcribe'` fail-closed behavior) under the retry/rebuild acceptance row.
- Legacy `PDF_SPEC.md` review (post-draft hardening) produced `pr-03` clarifications:
  - added explicit extraction -> embedding handoff contract/test coverage so `failure_stage='embed'` semantics are not only implied by retry policy
  - added explicit `pr-03` non-goals for server-side dual-parser fallback and PDF metadata/XMP/version extraction scope
  - clarified scanned/no-text non-fatal diagnostic (`E_PDF_TEXT_UNAVAILABLE`) remains optional and must not alter readable/no-quote degrade semantics
  - added backend extraction observability expectations for large-PDF operability (structured outcome logging) without frontend-style debug snapshot scope
- Final pre-commit audit fixes:
  - aligned `python/nexus/services/pdf_readiness.py` deliverable wording with accepted `S6-PR03-D07` (lightweight read predicate; write-time contiguity enforcement)
  - added `S6-PR03-D12` to lock synchronous post-extract embedding handoff failure semantics (`failure_stage='embed'` + preserve extracted artifacts)
  - added explicit atomicity/rollback test coverage for text-bearing page-span invariant failures (no partial persisted quote-text artifacts)
  - removed `python/nexus/services/upload.py` from the `pr-03` traceability deliverables row to avoid implying an unlisted code change
