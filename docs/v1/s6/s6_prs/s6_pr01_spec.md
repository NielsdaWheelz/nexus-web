# pr-01: typed-highlight data foundation

## goal
Add the additive storage/model foundation for unified logical highlights with typed anchors and PDF quote-text artifacts without changing public behavior.

## context
- `docs/v1/s6/s6_pr_roadmap.md` defines `pr-01` as additive schema/model groundwork with no dependencies and no public behavior rollout.
- `docs/v1/s6/s6_spec.md` Section `2` defines the S6 canonical data contracts for logical highlights, fragment/PDF anchor subtypes, `highlight_pdf_quads`, and `pdf_page_text_spans`.
- `docs/v1/s6/s6_spec_decisions.md` fixes the storage architecture and persistence contracts via `S6-D01`, `S6-D02`, `S6-D05`, and `S6-D06`.
- Current merged schema and ORM are fragment-offset-only in `migrations/alembic/versions/0003_slice2_highlights_annotations.py` and `python/nexus/db/models.py`.
- Current services/schemas/tests assume legacy `highlights(fragment_id,start_offset,end_offset)` behavior and must remain functionally unchanged in this PR.

## dependencies
- none

---

## deliverables

### `migrations/alembic/versions/0009_slice6_typed_highlight_data_foundation.py`
- Add S6 typed-highlight foundation schema surfaces:
  - logical-highlight support fields on `highlights` using an expand-phase shape (`anchor_kind`, `anchor_media_id`) that can remain dormant until `pr-02`
  - `highlight_fragment_anchors`
  - `highlight_pdf_anchors`
  - `highlight_pdf_quads`
  - `pdf_page_text_spans`
  - PDF text-readiness persistence fields on `media` (`plain_text`, `page_count`)
- Add structural constraints/indexes required for S6 foundations only:
  - one-to-one anchor subtype relations to `highlights`
  - FK constraints and cascade behavior
  - immutable-shape supporting checks (where enforceable at DB layer)
  - transitional dormant-field integrity on `highlights.anchor_kind` / `highlights.anchor_media_id`:
    - paired-null check (`both NULL` or `both non-NULL`)
    - `anchor_kind` enum/check when non-NULL (`fragment_offsets|pdf_page_geometry`)
  - retain the existing fragment duplicate unique index on `(user_id, fragment_id, start_offset, end_offset)` in `pr-01` as the compatibility-preserving duplicate-enforcement strategy under the nullable bridge
  - supporting PDF-anchor lookup/order indexes needed by future geometry duplicate/order logic (exact race-safe PDF duplicate enforcement is deferred to `pr-04`)
  - `highlight_pdf_anchors` row-local shape/domain integrity only (positive page/count/version fields, enum domains, offset non-negativity/paired-null, FK/1:1 shape); cross-table and lifecycle/match semantics are deferred to `pr-03`/`pr-04`/`pr-05`
  - `highlight_pdf_quads` row-shape integrity only (FKs, ordered row identity, `quad_idx` non-negative, required coordinate fields); geometry canonicalization semantics are deferred to `pr-04`
  - `pdf_page_text_spans` row-local integrity + uniqueness (full contiguous coverage/page-set lifecycle enforcement is owned by `pr-03`)
  - `media.page_count` DB domain check (`NULL` or `>= 1`) aligned to the S6 PDF page-count contract
- Preserve deploy-safe behavior for a greenfield baseline with zero existing production highlight data.
- Preserve legacy fragment-highlight storage surfaces in `highlights` (`fragment_id`, `start_offset`, `end_offset`) while converting them to a transitional nullable compatibility bridge that still enforces fragment-row validity for existing codepaths.
- Do not require any public API/service cutover in this migration.

### `python/nexus/db/models.py`
- Add ORM models/fields for the new S6 data foundation:
  - `Media.plain_text`, `Media.page_count`
  - typed highlight logical/core fields and relationships using the expand-phase dormant model (legacy fragment fields remain present)
  - `HighlightFragmentAnchor`, `HighlightPdfAnchor`, `HighlightPdfQuad`, `PdfPageTextSpan`
- Preserve existing `Highlight` / `Annotation` ORM behavior used by current services/routes/tests.
- Keep new ORM structures merge-safe and dormant until `pr-02` kernel adoption.

### `python/tests/test_migrations.py`
- Add migration-constraint tests for newly added S6 foundation tables/columns/indexes.
- Add tests proving legacy fragment highlight constraints/behavior remain intact after applying the new migration.
- Add tests for cascade and uniqueness behavior of new anchor subtype tables (schema-level only).
- Add tests covering greenfield-safe defaults/nullability semantics for dormant S6 columns/rows (no backfill required).

### `python/tests/test_models.py`
- Add/adjust ORM mapping tests only as needed to validate new relationships and prevent accidental breakage of existing `Highlight`/`Annotation` relationship loading.
- Do not add service/API behavior assertions here.

### `python/tests/test_highlights.py`
- Update direct SQL fixture/helpers only if required by the final migration shape (e.g., new non-null columns without DB defaults on `highlights`).
- Add one minimal fragment-highlight route regression smoke test to confirm ORM/schema foundation changes do not alter existing route behavior.
- Preserve existing test semantics and route expectations exactly.

---

## decision ledger

| question | decision | rationale | fallback/default |
|---|---|---|---|
| How should `pr-01` introduce typed logical-highlight fields on `highlights` without breaking existing direct inserts/services/tests, given a greenfield production baseline but non-greenfield codebase? | Use an expand-only migration shape: add typed-anchor foundation tables and logical-highlight fields additively, keep legacy fragment storage as the active compatibility path in `pr-01`, and defer all service/route cutover to `pr-02`. | Best merge safety and rollback posture; preserves behavior neutrality while establishing the canonical S6 data foundation. Greenfield removes production backfill needs but not code/test compatibility needs. | If implementation friction appears, keep the same expand-only shape and further relax dormant-field enforcement (without API/service cutover) until `pr-02`. |
| What exact transitional nullability/default/check contract should `highlights.anchor_kind` and `highlights.anchor_media_id` use in `pr-01` so legacy inserts stay valid while preventing malformed partial writes? | In `pr-01`, make both fields nullable with no DB defaults, and add DB checks enforcing (a) paired-null semantics and (b) valid `anchor_kind` values when non-NULL. No service writes depend on these fields in `pr-01`. | Minimizes malformed dormant state while preserving backward compatibility for legacy fragment inserts and avoiding `pr-02` service-cutover leakage. | If a legacy insert path unexpectedly breaks, keep both fields nullable and temporarily relax only the paired-null check; retain no-default/no-cutover posture and document the relaxation. |
| Should `pr-01` populate `highlight_fragment_anchors` for new fragment highlights during the dormant window (e.g., via trigger/dual-write), or leave subtype rows unpopulated until `pr-02` adopts typed kernel writes? | Do not populate fragment subtype rows in `pr-01` (no triggers and no service dual-write). `pr-02` owns typed-write adoption plus compatibility normalization/repair for rows created while `pr-01` schema was dormant. | Preserves `pr-01` as a pure expand-phase schema/ORM PR and keeps runtime synchronization logic in the PR that owns kernel semantics. Avoids hidden behavior in a migration PR. | If an unexpected runtime dependency appears before `pr-02`, add a narrowly-scoped one-shot repair utility in `pr-02` rather than introducing trigger-based dual-write in `pr-01`. |
| How should `pr-01` transition legacy fragment-specific columns on `highlights` (`fragment_id`, `start_offset`, `end_offset`) so future PDF logical highlights can exist in the same table without breaking current fragment APIs/tests? | Use a transitional nullable compatibility bridge in `pr-01`: make fragment columns nullable, replace fragment-only offset checks with conditional fragment-row validity checks, preserve duplicate protection for fragment rows, and allow all-NULL fragment columns for future non-fragment rows. | Unblocks unified logical highlights while preserving current fragment behavior during the dormant window and avoiding a split-core design. | If a legacy path breaks, relax only the new conditional checks/index shape as needed while preserving fragment semantics; do not abandon the unified `highlights` core. |
| What exact fragment-row duplicate enforcement shape should `pr-01` use after making `highlights.fragment_id/start_offset/end_offset` nullable (retain existing unique index vs partial unique index replacement)? | Retain the existing unique index in `pr-01` as the compatibility-first strategy; rely on PostgreSQL NULL-distinct semantics so fragment duplicate protection remains intact for fragment rows while non-fragment rows with NULL legacy fragment columns do not conflict. | Preserves current S2 duplicate semantics with minimum migration churn and test disruption in a data-foundation PR. Keeps `pr-01` merge-safe while remaining compatible with the nullable bridge for future PDF rows. | If typed-kernel rollout uncovers a correctness/clarity issue, move to an explicit partial unique index in a later PR with dedicated tests and roadmap/spec updates. |
| What exact `pr-01` schema/index deliverable should satisfy the S6 PDF geometry duplicate-enforcement requirement before `pr-04` adds PDF highlight writes, given `user_id` lives on `highlights` and no PDF writes exist yet? | In `pr-01`, add only supporting PDF-anchor lookup/order indexes; defer exact race-safe PDF duplicate enforcement to `pr-04` when PDF write paths exist (via transactional enforcement and/or additional schema/index strategy if needed). | Preserves `pr-01` scope and avoids premature denormalization/trigger work for a non-writable path while staying consistent with the S6 contract (`DB unique index and/or equivalent transactional enforcement`). | If a clean schema-only enforcement path emerges with no runtime complexity, it may be introduced later with explicit roadmap/L4 updates; `pr-01` remains support-only. |
| What DB-level constraints/checks should `pr-01` enforce on `pdf_page_text_spans` versus what must remain a `pr-03` lifecycle/population invariant (e.g., contiguity/full coverage across pages)? | In `pr-01`, enforce row-local validity + uniqueness only (`UNIQUE(media_id,page_number)`, positive page numbers, non-negative offsets, `end_offset >= start_offset`, valid extract-version domain/FK). Defer contiguous coverage/full-page-set/page_count alignment and same-normalization-pass lifecycle guarantees to `pr-03`. | Preserves clean schema integrity without pushing processing/lifecycle enforcement into a foundation PR or requiring trigger/procedural logic. | If a low-risk schema-only constraint is identified later, add it with explicit L4/roadmap updates; `pr-01` remains row-local-only by default. |
| What DB-level `pr-01` checks should exist for `highlight_pdf_quads` row shape (e.g., `quad_idx >= 0`, required coordinate fields) versus geometry normalization/canonicalization behavior deferred to `pr-04`? | In `pr-01`, enforce row-local quad shape integrity only: FK/cascade to `highlights`, ordered-row identity (`highlight_id` + `quad_idx` uniqueness/PK), `quad_idx >= 0`, and required coordinate fields non-null with numeric types. Defer canonicalization, degeneracy rejection, quantization, ordering semantics, and fingerprint correctness to `pr-04`. | Preserves a clean schema/runtime boundary and keeps canonical geometry behavior in the PR that introduces PDF highlight writes. | If a low-risk row-local check is discovered later, it may be added with explicit L4/roadmap updates; `pr-01` remains row-shape-only by default. |
| What DB-level `pr-01` checks should exist on `highlight_pdf_anchors` row-local fields (`page_number`, `rect_count`, match-status/offset coherence`) versus runtime/lifecycle rules owned by `pr-03`/`pr-04`/`pr-05`? | In `pr-01`, enforce row-local shape/domain checks only: 1:1 PK/FK shape, `media_id` FK, `page_number >= 1`, `rect_count >= 1`, `geometry_version >= 1`, match-status enum domain, `plain_text_match_version` null-or-positive domain, non-negative match offsets when present, and paired-null match offsets. Defer page_count range checks, cross-table anchor coherence, `rect_count` vs quad-row count, and match-status/offset semantic coherence to `pr-03`/`pr-04`/`pr-05`. | Preserves schema integrity while keeping lifecycle, cross-table, and quote-semantic validation in the PRs that own those behaviors. Avoids over-scoping `pr-01` into runtime semantics. | If a low-risk row-local check is later identified, add it with explicit L4/roadmap updates; `pr-01` remains row-local-only by default. |
| What exact enforcement strategy should later PRs use for cross-table PDF anchor coherence (`highlight_pdf_anchors.media_id == highlights.anchor_media_id`, `highlights.anchor_kind='pdf_page_geometry'`) without introducing fragile trigger logic? | Use a staged hybrid strategy: `pr-01` remains row-local schema only; `pr-04` owns authoritative transactional write-time validation/coherence for PDF anchors (no triggers); optional DB-level hardening may be evaluated later only if a clean, low-complexity pattern is justified after typed-write rollout. | Preserves strong S6 correctness through the PR that owns PDF writes while avoiding hidden trigger behavior and premature schema complexity in `pr-01`. Leaves room for future DB hardening without blocking the current roadmap. | If a compelling DB-level pattern emerges later, adopt it in a dedicated hardening/contraction PR with explicit roadmap/L4 updates; trigger-based enforcement remains out of scope by default. |

---

## traceability matrix

| l3 acceptance item | deliverable(s) | test(s) |
|---|---|---|
| S6 typed-highlight schema surfaces exist for logical highlights, anchor subtypes, and PDF page text span / quote-match persistence. | `migrations/alembic/versions/0009_slice6_typed_highlight_data_foundation.py`; `python/nexus/db/models.py` | `test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns`; `test_pr01_media_page_count_domain_check`; `test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints`; `test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness`; `test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules`; `test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics`; `test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules`; `test_pr01_orm_models_import_and_map_with_typed_anchor_foundation` |
| The rollout is deploy-safe for a greenfield baseline with zero existing highlight data; no production backfill is required. | `migrations/alembic/versions/0009_slice6_typed_highlight_data_foundation.py`; `python/tests/test_migrations.py` | `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill` |
| Existing HTML/EPUB/transcript highlight behavior remains unchanged at the API and UX level. | `python/nexus/db/models.py`; `python/tests/test_migrations.py`; `python/tests/test_highlights.py` | `test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration`; `test_pr01_fragment_highlight_route_smoke_unchanged` (representative of the shared fragment-highlight route path used by HTML/EPUB/transcript in `pr-01`); `test_pr01_direct_highlight_fixture_helper_remains_compatible` (if helper patch required) |
| The data foundation is merge-safe and can remain dormant until kernel adoption lands. | `migrations/alembic/versions/0009_slice6_typed_highlight_data_foundation.py`; `python/nexus/db/models.py`; `python/tests/test_migrations.py`; `python/tests/test_models.py` | `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill`; `test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window`; `test_pr01_orm_models_import_and_map_with_typed_anchor_foundation` |

---

## acceptance tests

### file: `python/tests/test_migrations.py`

**test: `test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns`**
- input: migrate database through `0009`; inspect schema metadata / system catalogs for `media.plain_text`, `media.page_count`, `highlight_fragment_anchors`, `highlight_pdf_anchors`, `highlight_pdf_quads`, `pdf_page_text_spans`, and new `highlights` logical-anchor fields required by the final pr-01 migration shape.
- output: all expected tables/columns/indexes/constraints exist with expected nullability/defaults and FK targets, including paired-null and `anchor_kind` value checks for dormant logical-anchor fields and supporting PDF-anchor lookup/order indexes (without requiring exact cross-table PDF duplicate uniqueness in `pr-01`).

**test: `test_pr01_media_page_count_domain_check`**
- input: migrate through `0009`; insert/update `media` rows with `page_count = NULL`, `1`, and invalid values (`0`, negative integers).
- output: `NULL` and positive values are accepted; `0` and negative values are rejected by the DB domain check introduced in `pr-01`.

**test: `test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration`**
- input: migrate through `0009`; insert user/media/fragment and exercise legacy `highlights` inserts for valid row, invalid color, invalid offsets, duplicate span.
- output: valid insert succeeds; fragment-row validity remains enforced through the compatibility-bridge check(s) (successor to `ck_highlights_offsets_valid` as specified); duplicate fragment span behavior remains preserved for fragment rows.

**test: `test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints`**
- input: migrate through `0009`; insert logical highlight rows plus subtype rows and attempt duplicate/invalid subtype inserts; delete core highlight row.
- output: one-to-one subtype uniqueness holds; FK violations reject invalid rows; deleting core highlight cascades subtype rows and does not alter `annotations` semantics.

**test: `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill`**
- input: migrate through `0009` on a database with no highlight rows; create/read legacy highlight rows only (no typed subtype rows for dormant path).
- output: migration succeeds without data backfill steps; legacy highlight flows remain insertable/readable at DB level under unchanged S2/S5 assumptions; newly added logical-anchor fields remain in the documented dormant state for legacy-inserted rows.

**test: `test_pr01_rejects_partial_dormant_logical_anchor_fields_on_highlights`**
- input: migrate through `0009`; attempt direct `highlights` inserts/updates that set only one of `anchor_kind` or `anchor_media_id`, and attempt a non-NULL invalid `anchor_kind`.
- output: DB check constraints reject partial/invalid dormant logical-anchor states while legacy all-NULL inserts still succeed.

**test: `test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window`**
- input: migrate through `0009`; create a legacy fragment-backed highlight row through existing insert path; query `highlight_fragment_anchors` for that highlight id.
- output: legacy highlight insert succeeds without subtype-row creation; absence of a fragment subtype row is tolerated in `pr-01` dormant mode and documented for `pr-02` normalization.

**test: `test_pr01_allows_future_non_fragment_logical_rows_to_leave_legacy_fragment_columns_null`**
- input: migrate through `0009`; insert a synthetic logical-highlight row representing a future non-fragment path with `fragment_id/start_offset/end_offset = NULL` and dormant or non-fragment-compatible logical-anchor fields per `pr-01` rules.
- output: row is accepted when it satisfies the transitional compatibility checks; fragment-row offset checks do not incorrectly reject all-NULL fragment legacy columns.

**test: `test_pr01_retained_fragment_unique_index_preserves_duplicate_semantics_under_nullable_bridge`**
- input: migrate through `0009`; insert one valid fragment-backed highlight row, attempt duplicate fragment row for same `(user_id, fragment_id, start_offset, end_offset)`, then insert multiple synthetic non-fragment rows with all-NULL legacy fragment columns.
- output: duplicate fragment row is still rejected; non-fragment rows with NULL legacy fragment columns do not conflict under the retained compatibility index strategy.

**test: `test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness`**
- input: migrate through `0009`; inspect indexes on `highlight_pdf_anchors` / related tables used for future PDF list-order and duplicate lookup paths.
- output: documented supporting indexes exist; `pr-01` does not claim exact cross-table PDF duplicate enforcement (that ownership remains `pr-04`).

**test: `test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules`**
- input: migrate through `0009`; insert `pdf_page_text_spans` rows exercising row-local valid/invalid cases (duplicate page row, invalid page number, negative offsets, `end<start`) and non-contiguous-but-row-valid page spans for the same media.
- output: row-local invalid cases are rejected; row-local valid rows succeed even if contiguity/full-coverage lifecycle conditions are not satisfied (those remain `pr-03` responsibilities).

**test: `test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics`**
- input: migrate through `0009`; insert `highlight_pdf_quads` rows exercising row-local valid/invalid cases (`quad_idx < 0`, duplicate `(highlight_id, quad_idx)`, null coordinate field) and rows that are row-valid but not guaranteed canonical by S6 geometry rules.
- output: row-local invalid cases are rejected; row-valid rows are accepted without `pr-01` attempting canonicalization/degeneracy/order enforcement (those remain `pr-04` responsibilities).

**test: `test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules`**
- input: migrate through `0009`; insert `highlight_pdf_anchors` rows exercising row-local valid/invalid cases (invalid `page_number`, invalid `rect_count`, invalid `geometry_version`, invalid match-status domain, negative match offsets, one-sided offset nullability) and rows that are row-valid but semantically unresolved (e.g., status/offset combinations reserved for later runtime validation).
- output: row-local invalid cases are rejected; row-local valid rows are accepted without `pr-01` enforcing page-count range, quad-count equality, or match-status/offset semantic coherence (owned by later PRs).

### file: `python/tests/test_models.py`

**test: `test_pr01_orm_models_import_and_map_with_typed_anchor_foundation`**
- input: import ORM models and initialize metadata/mappers after `pr-01` model changes.
- output: mapper configuration succeeds; new S6 models/relationships register without breaking existing `Highlight`/`Annotation` mappings.

### file: `python/tests/test_highlights.py`

**test: `test_pr01_fragment_highlight_route_smoke_unchanged`**
- input: run a minimal existing fragment-highlight route flow (create then fetch/list a fragment-backed highlight) against the migrated schema using current services/routes with no typed-anchor cutover.
- output: route responses and persisted behavior match pre-`pr-01` semantics (same success/error contract for valid fragment highlight inputs; no typed-anchor fields leak into public payloads). This is the representative `pr-01` API/UX regression smoke for HTML/EPUB/transcript because they continue to share fragment-backed highlight routes before `pr-02` kernel adoption.

**test: `test_pr01_direct_highlight_fixture_helper_remains_compatible`** (only if helper changes are required)
- input: call existing direct highlight fixture helper against migrated schema.
- output: helper still inserts a fragment-backed highlight row usable by existing tests without changing route semantics.

---

## non-goals
- does not implement typed-highlight shared service/visibility/context behavior (owned by `pr-02`)
- does not implement PDF processing/readiness or populate `media.plain_text` / `pdf_page_text_spans` (owned by `pr-03`)
- does not implement PDF highlight create/list/update endpoints or geometry normalization runtime logic (owned by `pr-04`)
- does not implement PDF quote matching/quote-to-chat behavior (owned by `pr-05`)
- does not implement frontend PDF reader/highlighting UX (owned by `pr-06` / `pr-07`)
- does not implement PDF metadata/XMP merge, PDF version extraction, or metadata persistence contract changes (out of S6 `pr-01` scope)

---

## constraints
- only touch files listed in deliverables unless spec is revised.
- follow established project patterns for Alembic migrations, SQLAlchemy ORM models, and migration tests.
- no public contract changes outside this PR's ownership.
- schema changes must be additive/merge-safe and tolerable while dormant until `pr-02`.
- assume zero existing production data (greenfield), but preserve compatibility with the current codebase and test suite.
- legacy fragment-column nullability changes must preserve current fragment-route semantics and direct test inserts while unblocking future non-fragment logical rows.

---

## boundaries (for ai implementers)

**do**:
- implement only the additive schema/ORM/test behaviors listed above.
- preserve existing highlight API behavior and error semantics by avoiding service/route cutover.
- add schema and ORM tests for every behavior-affecting migration decision (nullability, defaults, cascade, uniqueness).
- keep fragment duplicate/range/color semantics intact for fragment rows even if constraint/index names change in the compatibility bridge.
- retain the existing fragment duplicate unique-index behavior in `pr-01` unless the spec is revised with an approved replacement strategy.
- add only supporting PDF duplicate/order indexes in `pr-01`; keep exact PDF duplicate race-safety implementation for `pr-04`.
- enforce `pdf_page_text_spans` row-local validity/uniqueness only in `pr-01`; do not implement contiguity/full-coverage lifecycle enforcement.
- enforce `highlight_pdf_quads` row-shape integrity only in `pr-01`; do not implement geometry canonicalization/degeneracy/order/fingerprint semantics.
- enforce `highlight_pdf_anchors` row-local shape/domain checks only in `pr-01`; do not implement cross-table anchor coherence or match-status/offset semantic/lifecycle validation.
- keep cross-table PDF anchor coherence enforcement out of `pr-01`; `pr-04` owns transactional write-time enforcement and mismatch rejection without triggers.

**do not**:
- implement typed-highlight read/write kernel behavior from `pr-02`.
- implement PDF processing, quote matching, or endpoint logic from `pr-03`/`pr-04`/`pr-05`.
- rewrite highlight services/routes/schemas for anchor-discriminated output in this PR.
- add trigger-based dual-write or automatic subtype-row population for fragment highlights unless the spec is revised.
- introduce a separate logical-highlight core table that bypasses the approved unified `highlights` aggregate design.

---

## open questions + temporary defaults

| question | temporary default behavior | owner | due |
|---|---|---|---|
| None | n/a | n/a | n/a |

---

## checklist
- [x] every l3 acceptance bullet is in traceability matrix
- [x] every traceability row has at least one test
- [x] every behavior-changing decision has assertions
- [ ] only scoped files are touched (implementation-time verification; not a spec-drafting completeness check)
- [x] non-goals are explicit and enforced
