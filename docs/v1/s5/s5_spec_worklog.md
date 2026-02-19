# Slice 5 Spec Worklog

## Purpose
Capture evidence used to draft `docs/v1/s5/s5_spec.md`.
Only minimal upstream/code facts needed for each contract cluster are recorded.

## Evidence Log

### 2026-02-19 - Cluster: Scope and Acceptance Baseline
- `docs/v1/slice_roadmap.md:350` defines Slice 5 goal and outcome.
- `docs/v1/slice_roadmap.md:356` defines includes: EPUB ingestion, TOC extraction, fragment per chapter, chapter list/navigation, reuse highlights/chat.
- `docs/v1/slice_roadmap.md:368` defines acceptance criteria.
- `docs/v1/slice_roadmap.md:533` places Slice 5 after S4 in dependency spine.

### 2026-02-19 - Cluster: L0 Constraints Relevant to EPUB
- `docs/v1/constitution.md:242` defines fragment immutability law after ingestion.
- `docs/v1/constitution.md:264` requires EPUB resource URL rewrite during sanitization.
- `docs/v1/constitution.md:268` defines canonicalization rules that apply to HTML/EPUB fragments.
- `docs/v1/constitution.md:287` defines highlight anchoring model for HTML/EPUB fragments.
- `docs/v1/constitution.md:334` defines file-upload idempotency for EPUB/PDF.
- `docs/v1/constitution.md:430` defines `ready_for_reading` minimum for EPUB: sanitized HTML + canonical text.

### 2026-02-19 - Cluster: Current File Upload + Ingest Baseline
- `python/nexus/api/routes/media.py:161` and `python/nexus/api/routes/media.py:190` show current upload-init and ingest endpoints.
- `python/nexus/api/routes/media.py:141` shows generic fragments endpoint is already ordered by `idx` semantics.
- `python/nexus/services/upload.py:264` enforces creator-only confirm-ingest authorization.
- `python/nexus/services/upload.py:360` confirms dedupe winner flow by file hash.
- `python/nexus/services/upload.py:430` shows current ingest response shape is `{media_id, duplicate}` only.
- `python/nexus/api/routes/media.py:130-235` has no manual media retry route today (gap resolved in S5 contract).

### 2026-02-19 - Cluster: Data Model Baseline
- `python/nexus/db/models.py:228` defines media processing and file identity columns used by S5.
- `python/nexus/db/models.py:352` defines fragment schema and unique `(media_id, idx)`.
- `migrations/alembic/versions/0002_slice1_ingestion_framework.py:284` defines partial unique file-hash dedupe index for `pdf|epub`.

### 2026-02-19 - Cluster: Read/Highlight/Context Reuse Baseline
- `python/nexus/services/media.py:305` confirms fragment list contract sorted by `idx ASC`.
- `python/nexus/services/highlights.py:66` enforces media-ready requirement for highlight mutation.
- `python/nexus/services/highlights.py:84` and `python/nexus/services/highlights.py:93` derive offsets/exact/prefix/suffix from fragment canonical text.
- `python/nexus/services/context_rendering.py:147` renders highlight context from fragment/media and quote payload.
- `python/nexus/services/context_window.py:44` computes quote context from `fragment.canonical_text` and fragment blocks/fallback.

### 2026-02-19 - Cluster: UI/Contract Drift Baseline
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx:191` currently assumes single-fragment media (`fragment = fragments[0]`).
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx:201` fetches generic `/media/{id}/fragments` for rendering.
- This confirms need for explicit chapter-list/chapter-read APIs to avoid loading entire EPUB content in navigation workflows.

### 2026-02-19 - Cluster: Existing Test Baseline
- `python/tests/test_media.py:371` verifies fragments endpoint ordering by `idx ASC`.
- `python/tests/test_capabilities.py:71` and `python/tests/test_capabilities.py:86` verify EPUB can-read gating by processing status.
- `python/tests/test_permissions.py` covers canonical visibility predicate used by media reads.

### 2026-02-19 - Cluster: Legacy Working EPUB Specs Review
- `docs/old-documents-specs/EPUB_SPEC.md:35` and `docs/old-documents-specs/EPUB_SPEC.md:265` confirm practical extraction from EPUB spine/flow order.
- `docs/old-documents-specs/EPUB_SPEC.md:45` and `docs/old-documents-specs/EPUB_SPEC.md:204` show historical issues when raw EPUB HTML/styles were rendered without sanitizer constraints.
- `docs/old-documents-specs/EPUB_SPEC.md:211` identifies unresolved EPUB-internal asset references as a real behavior class that must degrade safely.
- `docs/old-documents-specs/EPUB_SPEC.md:244` records explicit legacy title fallback order (`metadata.title -> filename`) that is useful for deterministic behavior.
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:387` captures large-document payload risk when list endpoints include full content.
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:420` records offset-domain fragility from DOM-container identity drift; relevant as a caution for front-end reader implementation.

### 2026-02-19 - Legacy-to-New Compatibility Filter
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:19` (public bucket) conflicts with L0 private-storage contract and was explicitly rejected.
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:32` (`url` as type discriminator) conflicts with `media.kind` model and was rejected.
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:135` and `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:313` (redirect mutation APIs) conflict with current JSON envelope API model and were rejected.

### 2026-02-19 - Hardening Pass: Cross-Doc Consistency and Security
- `docs/v1/constitution.md:465` defines canonical pagination envelope as top-level `data` list plus `page` (`next_cursor`, `has_more`), requiring S5 chapter list alignment.
- `docs/v1/constitution.md:427` requires retry to delete partial chunk/embedding artifacts; S5 retry contract was tightened to include these artifacts in reset semantics.
- `docs/v1/constitution.md:22`, `docs/v1/constitution.md:23`, `docs/v1/constitution.md:46`, `docs/v1/constitution.md:47`, and `docs/v1/constitution.md:60` now make v1 upload-only scope explicit and defer EPUB/PDF URL ingest to v2.
- `python/nexus/db/models.py:1229` confirms `fragment_blocks` is an existing persisted artifact and must be included in retry cleanup contract.
- `docs/old-documents-specs/DOCUMENT_SYSTEM_SPEC.md:133` captures magic-byte validation expectations; hardening review identified missing normative archive-safety constraints (zip bomb/path traversal), now explicitly contractized in S5.

### 2026-02-19 - Hardening Pass: Final Determinism/Recovery Closure
- `docs/v1/slice_roadmap.md:126` and `docs/v1/slice_roadmap.md:130` require coherent retry UX/state semantics; S5 now explicitly marks `E_ARCHIVE_UNSAFE` as terminal in-row and defines fresh-upload remediation.
- `docs/v1/s5/s5_spec_decisions.md:9` requires deterministic TOC ordering; S5 now formalizes canonical `order_key` generation/comparison and tie-break rules to eliminate parser-dependent ordering drift.

## Evidence-Driven Conclusions Applied in Spec
- Upload confirmation must stay creator-authorized and hash-dedupe compatible.
- Chapter navigation requires dedicated lightweight APIs while preserving existing fragments endpoint.
- Retry needs a dedicated endpoint; no current public route exists for manual media retry.
- TOC persistence requires new schema; no merged table currently models EPUB TOC.
- Spine-order extraction and explicit readable-item filtering are now contractized.
- EPUB internal resource rewrite/degradation behavior is now explicit to prevent repeat legacy rendering ambiguity.
- EPUB title fallback order is now explicitly contractized to reduce parser drift (`OPF title -> filename -> literal fallback`).
- Chapter list pagination now matches constitution-level envelope (`data` + `page.next_cursor` + `page.has_more`).
- URL ingestion for EPUB/PDF is now explicitly deferred to v2 in L0/L1/S5 docs.
- Retry reset now contractizes full artifact cleanup (extraction + chunk/embedding artifacts) to prevent mixed-generation states.
- Chapter manifest derivations (`has_toc_entry`, `primary_toc_node_id`, counts) are explicitly deterministic.
- Archive safety limits and failure code (`E_ARCHIVE_UNSAFE`) are now normative in S5.
- `E_ARCHIVE_UNSAFE` retry behavior is now fully explicit (`E_RETRY_NOT_ALLOWED` terminal in-row; remediation is fresh upload).
- TOC `order_key` now has a normative canonical format and generation/comparison algorithm.
