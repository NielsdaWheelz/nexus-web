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
- Final alignment pass (2026-02-20) identified that deterministic `order_key` format must be DB-enforced, not semantics-only; S5 DDL now includes named constraint `ck_epub_toc_nodes_order_key_format`.

### 2026-02-20 - Hardening Pass: Canonical EPUB Asset Fetch Path Closure
- `docs/v1/s5/s5_spec.md:231` previously required safe fetch paths for rewritten internal resources but did not define a canonical retrieval contract.
- `python/nexus/api/routes/media.py:35` confirms existing binary fetch route pattern (`/media/image`) already exists under transport-only route constraints.
- `python/tests/test_route_structure.py:30` confirms route architecture constraints for new media routes (service-owned domain logic, no raw DB access in routes).
- Outcome: S5 now defines canonical internal asset route `GET /media/{media_id}/assets/{asset_key}` with deterministic key semantics, visibility masking, and explicit no-private-storage-URL exposure.

### 2026-02-20 - Hardening Pass: Final Contract Hygiene
- `docs/v1/s5/s5_roadmap.md:37` and `docs/v1/s5/s5_roadmap_ownership.md:18-19` had C3/C4 citation overlap on retry cleanup invariant 6.10; ownership citations were tightened so retry cleanup remains C4/PR-03 while C3/PR-02 remains extraction-output focused.
- `docs/v1/s5/s5_spec.md:339` and `docs/v1/s5/s5_spec.md:592` now explicitly scope envelope rules to JSON responses and document binary endpoint exception semantics for canonical asset fetch.
- `docs/v1/s5/s5_spec.md:21-31` and `docs/v1/s5/s5_spec_decisions.md:8` now align scope language to explicitly defer EPUB/PDF URL ingestion to v2.
- `docs/v1/s5/s5_spec.md:760` now maps resource rewrite traceability to invariant 6.17 (asset fetch safety) rather than archive-safety invariant 6.15.

### 2026-02-21 - Hardening Pass: L2/L3/L4 Lifecycle Contract Alignment
- `docs/v1/s5/s5_spec.md:393-447` and `docs/v1/s5/s5_prs/s5_pr03.md:40-82` had drift on `/ingest` re-entry behavior and `/retry` pre-cleanup source-integrity semantics.
- `docs/v1/s5/s5_spec.md:398-401` previously constrained `ingest_enqueued=false` to synchronous/internal execution only; approved PR-03 idempotent non-dispatch snapshot behavior required explicit L2 alignment.
- `docs/v1/s5/s5_spec.md:431-447` previously omitted retry source-integrity preconditions and associated deterministic error surface now required by PR-03.
- `docs/v1/s5/s5_roadmap.md:99-107` acceptance wording was broadened to explicitly include ingest idempotent re-entry and retry source-integrity precondition behavior.

### 2026-02-21 - Hardening Pass: PR-04 Read Semantics Closure
- Final PR-04 hardening introduced deterministic read semantics that were explicit in PR-04 L4 docs but partially implicit in L2.
- `docs/v1/s5/s5_spec.md:462-503` now explicitly defines chapter-list cursor domain (`>= 0`) and exhausted-page behavior for out-of-range cursor values.
- `docs/v1/s5/s5_spec.md:531-535` now explicitly guards `/chapters/{idx}` as single-chapter scoped (no adjacent/whole-book concatenation in payload).
- `docs/v1/s5/s5_spec_decisions.md` now records these as explicit slice-level decisions (S5-D23, S5-D24) to prevent future L4-only drift.

### 2026-02-21 - Hardening Pass: 4.7 Quote-to-Chat Compatibility Closure
- `docs/v1/s3/s3_spec.md:553-562` defines masked quote-to-chat gate behavior over context targets and readiness.
- `docs/v1/s3/s3_prs/s3_pr07.md:297-303` defines route-bound attach target semantics for highlight-to-chat handoff with no global target state.
- `python/nexus/services/send_message.py:345-379` confirms current masked context visibility behavior returns `E_NOT_FOUND` for invisible/missing context targets.
- Outcome: S5 section 4.7 now makes these compatibility semantics explicit (masked `404 E_NOT_FOUND` + route-bound attach handoff), removing prior L2 ambiguity.

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
- TOC `order_key` format is now enforced at the DB layer via named check constraint for drift resistance.
- EPUB-internal rewritten resource retrieval is now contractized with canonical safe fetch path semantics (`/media/{id}/assets/{asset_key}`), closing prior implementation ambiguity.
- PR ownership citations are now boundary-clean between extraction outputs (PR-02) and retry cleanup orchestration (PR-03).
- JSON envelope contract now explicitly documents binary endpoint exception semantics for EPUB asset fetch.
- `/ingest` now explicitly codifies idempotent re-entry behavior for non-duplicate non-pending rows (no redispatch and no attempt inflation).
- `/retry` now explicitly codifies source-integrity preconditions before cleanup/reset with deterministic non-mutating failure behavior.
- Quote-to-chat compatibility now explicitly codifies masked `E_NOT_FOUND` semantics and route-bound attach handoff behavior under S5 section 4.7.
