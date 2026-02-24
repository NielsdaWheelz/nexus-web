# Slice 6 PR-01 L4 Worklog

## Evidence Log

- Reviewed L4 process/template requirements in `docs/v1/sdlc/L4-pr-spec.md` (mandatory phases, required sections, traceability and acceptance-test rigor).
- Reviewed `pr-01` ownership in `docs/v1/s6/s6_pr_roadmap.md` (additive typed-highlight data foundation, no public behavior changes, greenfield deploy-safe).
- Reviewed S6 data contracts in `docs/v1/s6/s6_spec.md` for:
  - `media.plain_text` / `page_count`
  - logical `highlights` + typed anchor subtypes
  - `highlight_pdf_quads`
  - `pdf_page_text_spans`
  - PDF quote-match persistence metadata and invalidation rules (schema-level implications only)
- Reviewed S6 decision ledger in `docs/v1/s6/s6_spec_decisions.md` (`S6-D01`, `S6-D02`, `S6-D05`, `S6-D06`) to freeze pr-01 storage contracts.
- Reviewed current backend merged state:
  - fragment-only highlights in `migrations/alembic/versions/0003_slice2_highlights_annotations.py`
  - fragment-only `Highlight` ORM in `python/nexus/db/models.py`
  - highlight service/schema/tests assume legacy fragment columns

## Drafting Notes

- L4 spec skeleton created first (per L4 process).
- Traceability matrix seeded directly from the four `pr-01` L3 acceptance bullets.
- Deliverables intentionally limited to migration/ORM/tests to avoid scope smuggling into `pr-02+`.
- Resolved first material decision (`S6-PR01-D01`): `pr-01` uses an expand-only migration shape (additive typed-anchor foundation + dormant logical fields; no service/route cutover).
- Resolved second material decision (`S6-PR01-D02`): dormant logical-highlight fields in `highlights` use nullable/no-default paired-null + enum/check constraints (no `pr-01` service writes).
- Patched `docs/v1/s6/s6_pr_roadmap.md` to carry forward `pr-01` expand-only + dormant-field decisions into `pr-02` ownership notes.
- Resolved third material decision (`S6-PR01-D03`): no fragment subtype-row population (no triggers/dual-write) in `pr-01`; `pr-02` owns dormant-window normalization/repair.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to explicitly keep `pr-01` free of subtype dual-write and make `pr-02` responsible for dormant-window compatibility normalization.
- Resolved fourth material decision (`S6-PR01-D04`): legacy fragment columns become a transitional nullable compatibility bridge in `pr-01` (conditional fragment-row checks preserve existing behavior while allowing future non-fragment rows).
- Patched `docs/v1/s6/s6_pr_roadmap.md` to record the transitional bridge and future PR ownership for canonicalization/tightening.
- Resolved fifth material decision (`S6-PR01-D05`): retain the existing fragment duplicate unique index in `pr-01` and rely on PostgreSQL NULL-distinct semantics under the nullable bridge.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to record retained fragment duplicate-index semantics for `pr-01` and preservation expectations in later PRs.
- Resolved sixth material decision (`S6-PR01-D06`): `pr-01` adds supporting PDF-anchor indexes only; exact PDF duplicate race-safety is deferred to `pr-04`.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to make `pr-04` explicit owner of exact PDF duplicate enforcement and keep `pr-01` support-only.
- Resolved seventh material decision (`S6-PR01-D07`): `pr-01` enforces `pdf_page_text_spans` row-local validity/uniqueness only; contiguous/full-coverage lifecycle enforcement remains in `pr-03`.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to make `pr-03` explicit owner of contiguous/full-coverage `pdf_page_text_spans` enforcement over the `pr-01` row-local schema.
- Resolved eighth material decision (`S6-PR01-D08`): `pr-01` enforces `highlight_pdf_quads` row-shape integrity only; geometry canonicalization semantics remain in `pr-04`.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to make `pr-04` explicit owner of canonicalization/degeneracy/order/fingerprint semantics beyond `pr-01` quad row-shape integrity.
- Resolved ninth material decision (`S6-PR01-D09`): `pr-01` enforces `highlight_pdf_anchors` row-local shape/domain checks only; cross-table, lifecycle, and quote-semantic validation stays with `pr-03`/`pr-04`/`pr-05`.
- Patched `docs/v1/s6/s6_pr_roadmap.md` to make deferred `highlight_pdf_anchors` validation ownership explicit across `pr-03`/`pr-04`/`pr-05`.
- Resolved tenth material decision (`S6-PR01-D10`): use a staged hybrid strategy for cross-table PDF anchor coherence (no triggers in `pr-01`; `pr-04` owns transactional write-time coherence validation/mismatch rejection; optional DB-level hardening deferred to a later dedicated step only if justified).
- Patched `docs/v1/s6/s6_pr_roadmap.md` to explicitly record `pr-04` transactional cross-table anchor-coherence ownership (no triggers) and defer optional DB-level hardening to a later hardening/contraction step.
- Final L4 hardening pass found and fixed a traceability/acceptance-test exactness gap:
  - replaced stale/nonexistent traceability test references with exact `pr-01` test names
  - added an explicit minimal fragment-highlight route smoke test to concretely cover the “API/UX unchanged” acceptance item
  - re-verified no `TBD`/stop-point placeholders remain in `docs/v1/s6/s6_pr01_spec.md` / `docs/v1/s6/s6_pr01_decisions.md`
- Legacy `PDF_SPEC.md` review (working/basic implementation) produced one `pr-01` schema hardening import and one scope-clarity import:
  - added an explicit `media.page_count` DB-domain check (`NULL` or `>= 1`) and a dedicated migration test in `docs/v1/s6/s6_pr01_spec.md` to align the `pr-01` data foundation with the S6 page-count contract
  - added an explicit `pr-01` non-goal excluding PDF metadata/XMP merge, PDF version extraction, and metadata persistence contract changes (also mirrored in `docs/v1/s6/s6_pr_roadmap.md`)
  - no S6 L2 spec changes were required from this review because normalization, scanned/protected semantics, range-loading transport, and worker/CSP constraints are already covered there
- Final pre-commit cross-doc audit hardening:
  - clarified `pr-06` roadmap scope to explicitly allow the minimal backend/BFF/storage/CSP changes needed to satisfy the PDF.js transport contract (range loading, signed URL recovery, worker compatibility)
  - strengthened `pr-08` roadmap acceptance to require automated browser/E2E coverage for one end-to-end PDF happy path and one degrade/failure path
  - tightened `pr-01` L4 traceability/acceptance wording so the fragment-highlight route smoke is explicitly documented as the representative `pr-01` API/UX regression check for HTML/EPUB/transcript
  - annotated the remaining unchecked L4 checklist item (`only scoped files are touched`) as implementation-time verification rather than spec-drafting incompleteness
