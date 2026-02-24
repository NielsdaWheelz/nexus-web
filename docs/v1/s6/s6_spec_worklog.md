# Slice 6 Spec Worklog

## Purpose
Capture evidence used to draft `docs/v1/s6/s6_spec.md`.
Only minimal upstream/code facts needed for each contract cluster are recorded.

## Evidence Log

### 2026-02-22 - Cluster: Scope and Acceptance Baseline
- `docs/v1/slice_roadmap.md:383-386` defines Slice 6 goal/outcome (academic/scanned PDF reading).
- `docs/v1/slice_roadmap.md:387-394` defines in-scope items: PyMuPDF extraction, `media.plain_text`, PDF.js rendering, text-layer selection, geometry-based highlights, linked-items pane visibility.
- `docs/v1/slice_roadmap.md:395-399` excludes perfect text<->geometry reconciliation and PDF ingest-from-URL in v1.
- `docs/v1/slice_roadmap.md:399-406` defines acceptance criteria for stable highlights, stored exact text, quote-to-chat using stored text, overlap support, visibility + processing suites.
- `docs/v1/slice_roadmap.md:538-555` places S6 after S5 and before S7 in the dependency spine.

### 2026-02-22 - Cluster: L0 Constraints Relevant to PDF Reading/Highlights
- `docs/v1/constitution.md:23` and `docs/v1/constitution.md:174-175` make PDF stack choices explicit (`pymupdf`, `pdf.js`).
- `docs/v1/constitution.md:144-409` (see especially iframe/CSP rules) forbids document iframes and constrains browser rendering/security posture.
- `docs/v1/constitution.md:312-323` defines PDF highlights as a separate geometry-based model and PDF quote text behavior (`media.plain_text`, stored `exact`, no re-extraction at quote time, graceful degradation when region text extraction fails).
- `docs/v1/constitution.md:376-383` defines PDF highlight anchoring visibility semantics (`media_id + page_number` anchor media is the PDF media row).
- `docs/v1/constitution.md:412-438` defines processing lifecycle invariants and `ready_for_reading` gating.
- `docs/v1/constitution.md:431` explicitly allows PDF reading readiness before text extraction/search completeness.

### 2026-02-22 - Cluster: Existing API and Service Baseline (PDF Read Path + Capability Split)
- `python/nexus/api/routes/media.py:325` defines existing `GET /media/{media_id}/file` signed file download route (already suitable as PDF.js fetch path).
- `python/nexus/services/upload.py:531` defines signed download URL generation behind canonical media visibility checks.
- `python/nexus/services/capabilities.py:19-27` already includes `has_plain_text` in the capability derivation seam.
- `python/nexus/services/capabilities.py:86-119` already models PDF `can_read` (file-based) separately from PDF `can_quote` (`has_plain_text` gated).
- `python/nexus/services/media.py:87` currently hardcodes `has_plain_text=False` (TODO), confirming S6 must wire real `media.plain_text` readiness into `GET /media`.
- `python/nexus/schemas/media.py:29-50` defines `MediaOut`/`FragmentOut`; no S6 PDF-specific read/highlight schema exists yet.

### 2026-02-22 - Cluster: Current Highlight/Annotation/Quote Baseline (Fragment-Only Assumptions)
- `python/nexus/db/models.py:417-488` defines `highlights` as fragment-offset anchored and `annotations` as FK to `highlights`.
- `python/nexus/schemas/highlights.py:41-97` defines highlight schemas around fragment offsets only.
- `python/nexus/api/routes/highlights.py:39-219` exposes highlight routes scoped to `/fragments/{fragment_id}/highlights` and `/highlights/{highlight_id}` (no PDF route family yet).
- `python/nexus/services/highlights.py:49-58` loads highlights through `Fragment` visibility and media-read predicates.
- `python/nexus/services/highlights.py:165-189` serializes `HighlightOut` with fragment-offset fields.
- `python/nexus/services/context_rendering.py:147-183` renders highlight quote context by traversing `highlight.fragment` and fragment offset windows.
- `python/nexus/services/send_message.py:345-377` validates highlight/annotation context visibility through `highlight.fragment.media_id`.

### 2026-02-22 - Cluster: Current Data Model Baseline (S6 Gaps)
- `python/nexus/db/models.py:228-329` defines `media` and `media_file`; no persisted `media.plain_text` field exists yet in the merged model.
- `python/nexus/db/models.py:355-381` defines `fragments`; constitution requires PDF highlights to avoid fragment-offset anchoring for the highlight anchor itself.
- `python/nexus/db/models.py:417-488` confirms no polymorphic highlight anchor model exists today.

### 2026-02-22 - Cluster: Frontend Reader/Highlight Baseline
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx:191` (per prior S5 evidence) and current page code continue to assume a fragment-backed reader path.
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx:544-725` uses `selectionToOffsets(...)` and fragment canonical-text offsets for highlight creation, which is incompatible with PDF geometry anchoring.
- `apps/web/src/lib/highlights/selectionToOffsets.ts:253-269` is an HTML/DOM canonical-text selection -> offset converter, not a PDF text-layer geometry extractor.
- `apps/web/src/components/LinkedItemsPane.tsx:56` confirms quote-to-chat UI affordance already exists and should be reused for S6.
- No merged PDF.js/text-layer reader component or PDF-specific highlight route client code was found in `apps/web/src` during targeted search on 2026-02-22.

### 2026-02-22 - Cluster: Prior Slice Contract Reuse Constraints (S2/S3/S4)
- `docs/v1/s2/s2_spec.md:65-90` and `docs/v1/s2/s2_spec.md:322-489` define offset semantics, overlap/duplicate behavior, and server-derived `exact/prefix/suffix` for non-PDF highlights.
- `docs/v1/s3/s3_spec.md:358-399` and `docs/v1/s3/s3_spec.md:553-563` define quote-to-chat rendering and readiness gates, including PDF `has_plain_text` gating expectation.
- `docs/v1/s3/s3_spec.md:566-579` and `docs/v1/s4/s4_spec.md:340-365` define masked visibility semantics for context targets and social objects.
- `docs/v1/s4/s4_spec.md:766-789` defines highlight list/get shared-read visibility expectations (`mine_only` behavior and canonical predicate alignment).

### 2026-02-22 - Hardening Pass: Legacy `PDF_SPEC.md` Review (Adopt/Reject Filter)
- `docs/old-documents-specs/PDF_SPEC.md:139-169` provides useful parser-agnostic PDF text normalization and scanned/protected error distinctions; S6 incorporated normalization + degrade/fail semantics in current v1 terms.
- `docs/old-documents-specs/PDF_SPEC.md:545-582` and `docs/old-documents-specs/PDF_SPEC.md:624-630` capture frontend scale/lazy-render overlay behaviors that remain relevant; S6 added zoom/rotation reprojection and lazy-page highlight-appearance invariants/scenarios without constraining implementation to the old overlay algorithm.
- `docs/old-documents-specs/PDF_SPEC.md:610-613` identifies text-domain asymmetry risk; S6 added a capture-domain constraint for PDF text-layer-only selection/capture to prevent hidden DOM drift.
- `docs/old-documents-specs/PDF_SPEC.md:213-243` (public storage URLs, URL-as-type discriminator, CORS/public bucket assumptions) conflicts with v1 constitution and S6 authenticated file-fetch contract, and was explicitly rejected.
- `docs/old-documents-specs/PDF_SPEC.md:598-630` offset-based PDF annotation persistence is incompatible with constitution-required geometry anchors and S6 typed-anchor design, and was explicitly rejected (insights kept, model discarded).

### 2026-02-23 - Final Pre-Implementation Audit Hardening (non-versioning)
- Clarified that S6 PDF linked-items behavior is intentionally **active-page scoped** and tied to the page-scoped `GET /media/{media_id}/pdf-highlights` route; media-wide PDF highlight browsing remains deferred.
- Strengthened `GET /media/{media_id}/file` PDF.js transport contract with incremental/range loading compatibility and signed-URL expiry recovery expectations.
- Added PDF `prefix/suffix` derivation rules (server-derived from `media.plain_text` only on deterministic `unique` match; otherwise empty until enrichment).
- Added PDF highlight payload guardrails (`quads` count and `exact` length) to prevent oversize create/update requests from creating ambiguous perf behavior.
- Added acceptance scenarios covering upload -> `ready_for_reading` -> viewer open, signed URL expiry recovery, and active-page linked-items behavior.
- Added constitution CSP clarification for same-origin PDF.js worker execution via explicit `worker-src 'self'`.
- Deferred discussion: text-artifact generation/version binding for persisted PDF quote-match offsets after reprocessing/retry (left intentionally out of this patch pending follow-up design review).

### 2026-02-24 - Decision Closure: PDF quote-match offset protection without artifact generation binding
- Resolved follow-up design question: S6 will **not** add text-artifact generation/version columns for PDF quote-match metadata.
- Adopted invalidation+recompute contract instead: any retry/rebuild/repair path that rewrites `media.plain_text` and/or `pdf_page_text_spans` must reset `plain_text_match_*` to `pending`/null offsets and clear PDF `prefix/suffix` for that media before quote-to-chat uses the rewritten artifacts.
- Explicitly constrained retry classes: embedding/search retries must not rewrite PDF text artifacts; only text rebuild paths may do so (with mandatory invalidation).
- Rationale: avoids silent wrong nearby-context attachment while keeping S6 schema/contract complexity lower than artifact-generation binding.

### 2026-02-24 - Decision Closure: Linked-items pane reuse vs PDF-specific pane fork
- Code inspection confirmed the current linked-items pane implementation exists and is reusable as a shell, but is tightly coupled to HTML/EPUB fragment highlight DOM-anchor measurement today (`apps/web/src/components/LinkedItemsPane.tsx`, `apps/web/src/lib/highlights/alignmentEngine.ts`, `apps/web/src/lib/highlights/applySegments.ts`, `apps/web/src/app/(authenticated)/media/[id]/page.tsx`).
- Resolved S6 direction: reuse the existing linked-items pane product surface and row interactions; add a PDF renderer alignment/measurement adapter for active-page PDF highlights instead of shipping a separate PDF-only pane UI.
- Explicitly deferred: full cross-object linked-items architecture unification (documents + conversations + other object types) beyond the minimal adapter seam needed to support HTML/EPUB + PDF in S6.

## Evidence-Driven Conclusions Applied in Current Draft
- S6 should reuse `GET /media/{id}/file` for PDF.js file retrieval rather than inventing a parallel file endpoint.
- S6 must wire a real persisted PDF text readiness signal into `GET /media` capability derivation (`has_plain_text`) to preserve the `can_read` vs `can_quote` split already encoded in services.
- The current fragment-only highlight/annotation schema and quote rendering path make the PDF highlight persistence model a first-order architecture decision, not a local API addition.
- The constitution already answers the top-level question "offsets vs geometry" (geometry for PDF), but not the concrete schema/API integration strategy; `S6-D01` resolved this by adopting a unified logical highlight aggregate with typed anchors and shared annotations.
- `S6-D02` is now resolved in the draft with a versioned canonical PDF geometry contract (1-based page numbers, canonical page-space points, server normalization, fingerprinting, and derived sort keys).
- `S6-D05` is now resolved with persisted PDF quote-match metadata (`plain_text_match_*`) plus `pdf_page_text_spans` and a versioned deterministic page-local literal matcher (`plain_text_match_version=1`) that degrades safely on ambiguous/no-match outcomes.
- Legacy PDF spec review contributed three S6 hardening additions: parser-agnostic `media.plain_text` normalization contract, explicit scanned/protected PDF lifecycle semantics, and frontend zoom/lazy-render correctness requirements.
- Legacy public URL/CORS/type-discriminator assumptions and offset-based PDF annotation persistence were explicitly rejected to preserve constitution alignment and S6 typed-anchor geometry invariants.
- Final audit hardening added viewer transport, CSP worker, active-page linked-items, PDF `prefix/suffix` derivation, payload-bound contracts, and (now resolved) invalidation+recompute rules for PDF text-artifact rewrites without artifact-generation binding fields.
- S6 linked-items scope is now explicitly documented as "reuse existing pane shell + PDF alignment adapter" with a deferred broader pane-unification refactor.
- `docs/v1/s6/s6_spec.md` now has no open unresolved questions in Section `9`; remaining work is implementation planning (L3/L4), not L2 contract closure.

---
