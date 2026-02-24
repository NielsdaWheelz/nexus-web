# Slice 6 — PR Roadmap

> Maintenance rule: when an L4 PR-spec decision materially changes a later PR's responsibilities or sequencing, patch this roadmap immediately to record the carry-forward ownership/dependency impact.

## 1. Dependency Graph

```text
pr-01 (typed-highlight data foundation)
  -> pr-02 (typed-highlight kernel compatibility)
  -> pr-03 (pdf processing + readiness + text artifacts)

pr-02 + pr-03
  -> pr-04 (pdf highlight apis + geometry canonicalization)

pr-03 + pr-04
  -> pr-05 (pdf quote-to-chat compatibility)

pr-03
  -> pr-06 (frontend pdf reader read path)

pr-04 + pr-05 + pr-06
  -> pr-07 (frontend pdf highlights + linked-items adapter)

pr-02 + pr-03 + pr-05 + pr-07
  -> pr-08 (acceptance hardening + regression closure)
```

## 2. Ownership Matrix

| contract cluster (from l2) | owning pr |
|---|---|
| C1. Typed-highlight storage/model foundation (`highlights` core + anchor subtypes + PDF quote-match fields + page spans) | pr-01 |
| C2. Typed-highlight visibility/context kernel compatibility across S3/S4 behavior (non-fragment assumptions removed) | pr-02 |
| C3. PDF processing lifecycle/readiness/error semantics (`ready_for_reading` vs `pdf_quote_text_ready`, scanned/protected behavior, retry invalidation rules) | pr-03 |
| C4. PDF highlight API surfaces (create/list/update/detail compatibility) + geometry canonicalization/fingerprinting/payload bounds | pr-04 |
| C5. PDF quote-to-chat compatibility using persisted match metadata + degrade-safe behavior + enrichment path semantics | pr-05 |
| C6. Frontend PDF reader read path (PDF.js rendering, file transport expiry recovery, text-layer readiness) | pr-06 |
| C7. Frontend PDF highlighting UX (selection capture, overlay reprojection/lazy-page behavior) + linked-items pane PDF adapter (active-page scoped) | pr-07 |
| C8. Slice acceptance/regression closure (visibility + processing suites, end-to-end acceptance coverage, rollout hardening) | pr-08 |

## 3. Acceptance Coverage Map

| l2 acceptance scenario | owning pr(s) |
|---|---|
| scenario 1: selection creates stable highlight | pr-04, pr-07 |
| scenario 2: exact text stored at highlight creation | pr-04, pr-07 |
| scenario 3: quote-to-chat waits for pdf plain text | pr-03, pr-05 |
| scenario 4: quote-to-chat uses stored text, not re-extraction | pr-05 |
| scenario 5: overlapping pdf highlights are supported | pr-04, pr-07 |
| scenario 6: visibility suite passes for pdf highlights | pr-02, pr-08 |
| scenario 7: processing-state suite passes for pdf read vs quote gating | pr-03, pr-08 |
| scenario 8: linked-items pane renders pdf highlights | pr-07 |
| scenario 9: ambiguous-or-missing plain-text match degrades safely | pr-05 |
| scenario 10: zoom-or-rotation redraw preserves visual alignment | pr-07 |
| scenario 11: lazy-rendered pages reveal highlights when page text layer appears | pr-07 |
| scenario 12: scanned-or-image-only pdf degrades to visual-read-only semantics | pr-03, pr-06 |
| scenario 13: password-protected pdf fails deterministically in v1 | pr-03 |
| scenario 14: uploaded pdf reaches readable viewer state through the existing file route | pr-03, pr-06 |
| scenario 15: signed file url expiry is recoverable for an active pdf viewer session | pr-06 |
| scenario 16: linked-items pane tracks the active pdf page in s6 page-scoped mode | pr-07 |
| scenario 17: pdf text-artifact rebuild invalidates stale quote-match metadata and safely recovers | pr-03, pr-05 |
| scenario 18: pdf highlights reuse the existing linked-items pane shell via a pdf alignment adapter | pr-05, pr-07 |

## 4. PRs

### pr-01: typed-highlight data foundation
- **goal**: Add the additive storage/model foundation for unified logical highlights with typed anchors and PDF quote-text artifacts without changing public behavior.
- **dependencies**: none
- **acceptance**:
  - S6 typed-highlight schema surfaces exist for logical highlights, anchor subtypes, and PDF page text span / quote-match persistence.
  - The rollout is deploy-safe for a greenfield baseline with zero existing highlight data; no production backfill is required.
  - Existing HTML/EPUB/transcript highlight behavior remains unchanged at the API and UX level.
  - The data foundation is merge-safe and can remain dormant until kernel adoption lands.
  - `pr-01` uses an expand-only, dormant-field rollout for logical highlight fields on `highlights`; legacy fragment columns/constraints remain the active path until `pr-02`.
  - `pr-01` converts legacy fragment columns on `highlights` into a transitional nullable compatibility bridge that preserves current fragment-row semantics while allowing future non-fragment logical rows.
  - `pr-01` retains fragment duplicate semantics under the nullable bridge by preserving the existing fragment duplicate unique-index behavior (explicit partial-index refactor deferred unless later justified).
  - `pr-01` adds supporting PDF-anchor indexes only; exact race-safe PDF duplicate enforcement is deferred to `pr-04` when PDF highlight writes exist.
- **non-goals**:
  - No production data backfill/cutover of pre-existing highlight rows (greenfield baseline assumption).
  - No trigger/service dual-write that populates typed anchor subtype rows during the dormant `pr-01` window.
  - No PDF metadata/XMP merge, PDF version extraction, or metadata persistence contract changes.
  - No PDF highlight API rollout.
  - No quote-to-chat behavior changes.
  - No frontend PDF reader/highlighting behavior.

### pr-02: typed-highlight kernel compatibility
- **goal**: Make shared highlight/context/visibility kernel behavior anchor-kind-aware while preserving existing fragment-backed semantics.
- **dependencies**: pr-01
- **acceptance**:
  - Shared visibility and context-target resolution operate on logical highlights across anchor kinds.
  - Existing fragment-backed highlight reads, annotations, and quote-context behavior remain functionally unchanged.
  - Existing fragment-route API behavior is preserved while internal typed-highlight canonical paths are adopted for S6 rollout readiness.
  - `pr-02` adopts and validates `pr-01` dormant logical-highlight fields (`anchor_kind`, `anchor_media_id`) and handles compatibility normalization for rows created while `pr-01` schema was dormant.
  - `pr-02` tolerates and repairs fragment highlights created during the `pr-01` dormant window that do not yet have `highlight_fragment_anchors` subtype rows.
  - `pr-02` treats legacy fragment columns on `highlights` as a transitional compatibility bridge and shifts canonical fragment-anchor reads/writes toward subtype rows without changing fragment-route product semantics.
  - `pr-02` preserves fragment duplicate behavior under the `pr-01` retained compatibility index unless a separately-reviewed index refactor is introduced.
  - Test/fixture expectations are updated for the typed-highlight internal model without changing pre-S6 product semantics.
  - Typed-highlight serializers/service seams are ready for later PDF endpoint expansion.
- **non-goals**:
  - No PDF create/list/update API rollout.
  - No PDF quote matching logic rollout.
  - No frontend PDF features.

### pr-03: pdf processing readiness and text artifacts
- **goal**: Implement S6 PDF processing/readiness semantics, normalized `media.plain_text` + `pdf_page_text_spans`, and retry invalidation rules.
- **dependencies**: pr-01
- **acceptance**:
  - PDFs uploaded through the existing upload flow are recognized and routed into the S6 PDF processing lifecycle with the defined readiness/failure transitions.
  - PDF processing can produce `page_count`, normalized `media.plain_text`, and contiguous page-span indexing for quote/search readiness.
  - `pr-03` enforces/validates contiguous/full-page-set `pdf_page_text_spans` lifecycle invariants (beyond the row-local schema checks introduced in `pr-01`) before quote-capable readiness is considered satisfied.
  - `pr-03` owns lifecycle/invalidation validation for PDF quote-match metadata on `highlight_pdf_anchors` beyond the row-local schema checks introduced in `pr-01`.
  - `ready_for_reading` and PDF quote/search readiness are correctly split per S6 lifecycle rules.
  - Scanned/image-only and password-protected PDF behaviors follow S6 deterministic degrade/fail semantics.
  - Retry/rebuild paths honor S6 invalidation rules for PDF quote-match metadata and do not rewrite text artifacts on embedding/search-only retries.
  - `GET /media/{id}` capability derivation reflects real PDF `has_plain_text` readiness.
- **non-goals**:
  - No PDF highlight CRUD APIs.
  - No frontend PDF viewer integration.
  - No quote-to-chat PDF context rendering changes beyond readiness/error gating prerequisites.

### pr-04: pdf highlight apis and geometry canonicalization
- **goal**: Add S6 PDF highlight API surfaces and generic highlight-route compatibility backed by canonical PDF geometry normalization/fingerprinting.
- **dependencies**: pr-02, pr-03
- **acceptance**:
  - PDF highlight create/list/update flows are available with 1-based page numbering and canonical page-space geometry payload semantics.
  - Server-side geometry normalization, fingerprinting, duplicate detection, deterministic ordering, and payload bounds follow the S6 contract.
  - Overlapping PDF highlights are supported while exact duplicates are rejected per geometry identity rules.
  - PDF logical highlight writes use the unified `highlights` core together with the `pr-01` transitional legacy-fragment-column bridge (`fragment_id/start_offset/end_offset` remain `NULL` for PDF rows under bridge constraints).
  - `pr-04` owns exact race-safe PDF duplicate enforcement for PDF highlight writes (transactional enforcement and/or schema/index refinement), building on `pr-01` supporting indexes.
  - `pr-04` owns PDF geometry canonicalization semantics (degeneracy rejection, quantization, canonical ordering, fingerprint correctness), building on the `pr-01` `highlight_pdf_quads` row-shape schema.
  - `pr-04` owns authoritative transactional write-time validation of `highlight_pdf_anchors` cross-table coherence and geometry-derived anchor fields (beyond the row-local domains introduced in `pr-01`), including mismatch rejection without trigger-based enforcement.
  - Any DB-level hardening for PDF anchor cross-table coherence is explicitly deferred to a later dedicated hardening/contraction step and is not a prerequisite for S6 `pr-04` completion.
  - Generic highlight detail/delete/annotation interactions remain compatible with typed-highlight semantics.
- **non-goals**:
  - No frontend PDF rendering or selection UI.
  - No quote-to-chat nearby-context enrichment logic.

### pr-05: pdf quote-to-chat compatibility
- **goal**: Extend quote-to-chat/context rendering to support PDF highlights and annotations using persisted PDF quote-match metadata with deterministic degrade-safe behavior.
- **dependencies**: pr-03, pr-04
- **acceptance**:
  - Quote-to-chat for PDF highlights/annotations uses stored `exact` as authoritative quote text and never re-extracts selection text at quote time.
  - Nearby context is included only for deterministic `unique` PDF matches and omitted safely for ambiguous/missing/empty cases.
  - Pending/invalidation states follow S6 enrichment and safe-degradation rules.
  - `pr-05` owns quote-semantic validation/coherence of persisted PDF match-status/offset metadata usage (beyond the row-local schema checks introduced in `pr-01`).
  - Visibility and masked-existence semantics remain aligned with S3/S4 expectations for PDF context targets.
- **non-goals**:
  - No frontend PDF viewer/highlight UI rollout.
  - No changes to PDF geometry persistence.

### pr-06: frontend pdf reader read path
- **goal**: Ship the S6 PDF web viewer read path using PDF.js and the existing authenticated file route contract.
- **dependencies**: pr-03
- **acceptance**:
  - Users can open readable PDF media in a PDF.js-based viewer without iframes.
  - The end-to-end PDF.js read path is compatible with S6 incremental/range loading expectations through the canonical `GET /media/{id}/file` -> signed URL contract.
  - Viewer file fetch uses the canonical `GET /media/{id}/file` path and handles signed URL expiry recovery during active sessions.
  - PDF.js worker execution remains compatible with the constitution CSP (same-origin worker path under `worker-src 'self'`) without introducing public-storage URL assumptions.
  - `pr-06` may include the minimal backend/BFF/storage/CSP configuration changes required to satisfy the S6 PDF.js transport contract (range loading, signed URL recovery, worker compatibility), even though the primary deliverable is the frontend reader path.
  - Text-layer readiness and scanned/image-only visual-read-only behavior match S6 reader UI contract expectations.
  - Password-protected/failed PDFs surface deterministic non-success behavior consistent with S6 processing outcomes.
- **non-goals**:
  - No persistent PDF highlight create/update UX.
  - No linked-items pane PDF integration.

### pr-07: frontend pdf highlights and linked-items adapter
- **goal**: Add persistent PDF highlighting UX and integrate PDF highlights into the existing linked-items pane shell via a PDF alignment adapter.
- **dependencies**: pr-04, pr-05, pr-06
- **acceptance**:
  - Text-layer selection capture can create/update PDF highlights using the S6 PDF highlight APIs and stored `exact`.
  - Persisted PDF highlights render with stable reprojection across zoom/rotation and appear as lazy-rendered pages become available.
  - The existing linked-items pane shell is reused for active-page PDF highlights via a PDF renderer alignment/measurement adapter.
  - Row interactions (focus/scroll/quote/annotation affordances) work for PDF highlights in S6 page-scoped mode using the reused linked-items pane shell and compatible backend routes.
- **non-goals**:
  - No full cross-object linked-items pane unification beyond the PDF adapter integration required for S6.
  - No perfect text↔geometry reconciliation.

### pr-08: acceptance hardening and regression closure
- **goal**: Close the slice by validating S6 acceptance coverage, regression suites, and rollout hardening across the integrated backend/frontend PDF path.
- **dependencies**: pr-02, pr-03, pr-05, pr-07
- **acceptance**:
  - S6 acceptance scenarios are covered end-to-end across merged PR behavior, including upload-to-viewer, quote gating, PDF highlighting, linked-items integration, and retry invalidation recovery.
  - At least one automated browser/E2E happy-path test covers `upload -> processing -> viewer open -> persistent PDF highlight -> reload -> quote-to-chat` using the merged S6 path.
  - At least one automated degrade/failure-path test covers either scanned/image-only visual-read-only behavior or password-protected deterministic failure semantics.
  - Visibility and processing-state regression suites pass with PDF behavior included.
  - Integration defects and regression fixes discovered during slice closure are resolved without reassigning primary ownership of C1-C7, changing S6 L2 contract boundaries, or expanding S6 scope.
- **non-goals**:
  - No new S6 scope expansion (PDF ingest-from-URL, perfect reconciliation, or full linked-items unification).
