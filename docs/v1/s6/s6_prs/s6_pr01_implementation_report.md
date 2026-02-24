# S6 PR-01: Typed-Highlight Data Foundation — Implementation Report

## 1. Summary of Changes

Additive schema/model/test groundwork for unified logical highlights with typed anchors and PDF quote-text artifacts. Zero public behavior changes.

### Files Changed

| File | Action | Purpose |
|---|---|---|
| `migrations/alembic/versions/0009_slice6_typed_highlight_data_foundation.py` | Created | 7-step migration: media fields, dormant highlight fields, nullable bridge, 4 new tables, constraints, indexes |
| `python/nexus/db/models.py` | Modified | 4 new ORM models, extended `Media` + `Highlight`, dormant-safe relationships |
| `python/tests/test_migrations.py` | Modified | 13 new migration tests in `TestS6PR01Migration0009`, 1 existing S2 test assertion updated |
| `python/tests/test_models.py` | Modified | 1 new ORM mapper compatibility test |
| `python/tests/test_highlights.py` | Modified | 1 new fragment-highlight route regression smoke test |

### New Tables

- `highlight_fragment_anchors` — 1:1 anchor subtype for fragment-offset highlights
- `highlight_pdf_anchors` — 1:1 anchor subtype for PDF geometry highlights + quote-match metadata
- `highlight_pdf_quads` — geometry segments (quad coordinates per highlight)
- `pdf_page_text_spans` — page-indexed offsets into `media.plain_text`

### Schema Extensions

- `media`: added `plain_text` (TEXT, nullable), `page_count` (INTEGER, nullable, CHECK >= 1)
- `highlights`: added `anchor_kind` (TEXT, nullable, CHECK enum), `anchor_media_id` (UUID, nullable, FK → media), paired-null CHECK; made `fragment_id`/`start_offset`/`end_offset` nullable with transitional bridge CHECK

---

## 2. Problems Encountered

### Problem 1: Smoke Test 404

**Symptom**: `test_pr01_fragment_highlight_route_smoke_unchanged` returned 404 on highlight creation.

**Root Cause**: Direct SQL inserts into `library_media` weren't visible to the auth_client's connection context. The API endpoint's `can_read_media` check couldn't find the media-library association.

**Resolution**: Replaced direct `library_media` insertion with the established `create_media_and_fragment()` + `add_media_to_library()` helper pattern used by other tests in the file.

### Problem 2: S2 Constraint Name Mismatch

**Symptom**: `make verify` failed on `TestS2HighlightsAnnotationsConstraints.test_invalid_highlight_offsets_rejected` — expected `ck_highlights_offsets_valid` in the IntegrityError, got `ck_highlights_fragment_bridge`.

**Root Cause**: Migration 0009 drops `ck_highlights_offsets_valid` and replaces it with `ck_highlights_fragment_bridge`. Same enforcement semantics for fragment rows, different name.

**Resolution**: Updated the S2 test assertion to reference the new constraint name. The behavioral invariant is preserved — invalid fragment offsets are still rejected.

---

## 3. Solutions Implemented

| Solution | Description |
|---|---|
| Transitional nullable bridge | Legacy fragment columns made nullable; conditional CHECK `ck_highlights_fragment_bridge` enforces fragment-row validity (all three non-NULL with valid offsets) while allowing all-NULL for future PDF rows |
| Dormant typed-anchor fields | `anchor_kind` + `anchor_media_id` added as nullable with paired-null CHECK and enum CHECK; no service writes in PR-01 |
| Retained unique index | `uix_highlights_user_fragment_offsets` kept unchanged; PG NULL-distinct semantics prevent false conflicts for non-fragment rows |
| Row-local-only enforcement | All new tables enforce only row-shape/domain constraints per spec; cross-table coherence, lifecycle, and canonicalization deferred to PR-03/04/05 |
| Decimal geometry coordinates | `Numeric` type for quad coordinates and sort fields, matching spec's 0.001-pt precision requirement |

---

## 4. Decisions Made

| Decision | Rationale |
|---|---|
| No `anchor_media` relationship on `Highlight` model | Avoids SQLAlchemy FK ambiguity since `Highlight` already reaches `Media` via `Fragment`. PR-02 can add when kernel adoption lands. |
| Updated S2 test constraint name assertion | `ck_highlights_offsets_valid` → `ck_highlights_fragment_bridge` is a name change with identical enforcement semantics for fragment rows. Updating the test is correct. |
| Non-unique supporting indexes for PDF tables | Exact race-safe duplicate enforcement deferred to PR-04 per spec. |
| `server_default="pending"` for `plain_text_match_status` | Spec requires initial state for new PDF anchors before quote-matching runs. |
| No `test_pr01_direct_highlight_fixture_helper_remains_compatible` test | Spec lists this as "only if helper changes are required." No helper changes were required — the smoke test covers the equivalent path. |

---

## 5. Deviations from L4/L3/L2

**None.** All implementation follows the spec exactly. Every acceptance item is satisfied. Every constraint and index matches the spec's requirements. No files outside the deliverables list were touched.

---

## 6. Commands to Run New/Changed Behavior

```bash
# Run S6 PR-01 migration tests (13 tests)
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations" \
  NEXUS_ENV=test uv run pytest -v tests/test_migrations.py::TestS6PR01Migration0009

# Run ORM mapper compatibility test
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test" \
  NEXUS_ENV=test uv run pytest -v tests/test_models.py::TestS6PR01OrmMapperCompatibility

# Run fragment highlight route smoke test
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test" \
  NEXUS_ENV=test uv run pytest -v tests/test_highlights.py::TestS6PR01FragmentHighlightRouteSmoke
```

---

## 7. Commands Used to Verify Correctness

```bash
# Full verification (lint + format + typecheck + build + all tests)
make verify

# Results: all 66 migration tests passed, all backend tests passed,
# all 333 frontend tests passed, lint/format/typecheck/build all green.
```

---

## 8. Traceability Table

| Acceptance Item | Files | Tests | Status |
|---|---|---|---|
| S6 typed-highlight schema surfaces exist (tables, columns, indexes, constraints) | `0009_*.py`, `models.py` | `test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns` | PASS |
| `media.page_count` DB domain check (NULL or >= 1) | `0009_*.py`, `models.py` | `test_pr01_media_page_count_domain_check` | PASS |
| Legacy fragment highlight constraints preserved after migration | `0009_*.py`, `models.py` | `test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration` | PASS |
| Anchor subtype cascade + uniqueness constraints | `0009_*.py`, `models.py` | `test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints` | PASS |
| Greenfield defaults allow dormant schema without backfill | `0009_*.py` | `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill` | PASS |
| Partial dormant logical anchor fields rejected | `0009_*.py` | `test_pr01_rejects_partial_dormant_logical_anchor_fields_on_highlights` | PASS |
| No fragment subtype dual-write required during dormant window | `0009_*.py` | `test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window` | PASS |
| Future non-fragment rows can leave fragment columns NULL | `0009_*.py` | `test_pr01_allows_future_non_fragment_logical_rows_to_leave_legacy_fragment_columns_null` | PASS |
| Retained fragment unique index preserves duplicate semantics under nullable bridge | `0009_*.py` | `test_pr01_retained_fragment_unique_index_preserves_duplicate_semantics_under_nullable_bridge` | PASS |
| PDF anchor supporting indexes exist (no exact duplicate uniqueness in PR-01) | `0009_*.py` | `test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness` | PASS |
| `pdf_page_text_spans` row-local validity (not contiguity lifecycle) | `0009_*.py` | `test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules` | PASS |
| `highlight_pdf_quads` row-shape (not canonicalization) | `0009_*.py` | `test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics` | PASS |
| `highlight_pdf_anchors` row-local shape/domains (not semantic coherence) | `0009_*.py` | `test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules` | PASS |
| ORM models import and map correctly | `models.py` | `test_pr01_orm_models_import_and_map_with_typed_anchor_foundation` | PASS |
| Existing fragment highlight route behavior unchanged | `models.py`, `test_highlights.py` | `test_pr01_fragment_highlight_route_smoke_unchanged` | PASS |
| Deploy-safe for greenfield baseline | `0009_*.py` | `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill` | PASS |
| Merge-safe / dormant until kernel adoption | `0009_*.py`, `models.py` | `test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill`, `test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window`, `test_pr01_orm_models_import_and_map_with_typed_anchor_foundation` | PASS |

---

## 9. Commit Message

```
feat(s6): pr-01 typed-highlight data foundation

Add the additive storage/model/test foundation for S6 unified logical
highlights with typed anchors and PDF quote-text artifacts. No public
behavior changes.

Migration 0009 — schema changes:
- media: add plain_text (TEXT), page_count (INTEGER, CHECK >= 1)
- highlights: add anchor_kind (TEXT, CHECK enum) and anchor_media_id
  (UUID, FK → media) with paired-null CHECK; convert fragment_id,
  start_offset, end_offset to transitional nullable bridge with
  conditional fragment-row validity CHECK (ck_highlights_fragment_bridge
  replaces ck_highlights_offsets_valid)
- Create highlight_fragment_anchors (1:1 anchor subtype for
  fragment-offset highlights)
- Create highlight_pdf_anchors (1:1 anchor subtype for PDF geometry
  highlights with quote-match metadata fields and supporting indexes)
- Create highlight_pdf_quads (geometry segments with ordered PK)
- Create pdf_page_text_spans (page-indexed offsets into media.plain_text
  with row-local validity constraints)

ORM model changes (python/nexus/db/models.py):
- Add HighlightFragmentAnchor, HighlightPdfAnchor, HighlightPdfQuad,
  PdfPageTextSpan models
- Extend Media with plain_text, page_count, pdf_page_text_spans rel
- Extend Highlight with anchor_kind, anchor_media_id (dormant),
  nullable fragment bridge, and new anchor subtype relationships
  with cascade delete-orphan

Test coverage (15 new tests):
- 13 migration tests (TestS6PR01Migration0009): table/column existence,
  nullability, dormant field paired-null/enum checks, media page_count
  domain, legacy fragment bridge preservation, anchor subtype cascade +
  uniqueness, greenfield defaults, non-fragment NULL rows, retained
  unique index duplicate semantics, PDF supporting indexes, row-local
  validity for pdf_page_text_spans/highlight_pdf_quads/
  highlight_pdf_anchors
- 1 ORM mapper compatibility test (TestS6PR01OrmMapperCompatibility)
- 1 fragment highlight route smoke test
  (TestS6PR01FragmentHighlightRouteSmoke)
- Updated 1 existing S2 test assertion for renamed constraint

Design posture:
- Expand-only / dormant: new fields and tables are additive and dormant
  until pr-02 kernel adoption. No service/route cutover.
- Greenfield-safe: no production backfill required.
- Row-local enforcement only: cross-table coherence, lifecycle, and
  canonicalization deferred to pr-03/04/05 per spec.
- Compatibility bridge: legacy fragment inserts continue to work with
  conditional validity; PostgreSQL NULL-distinct semantics preserve
  existing unique index duplicate protection for fragment rows.

Implements: docs/v1/s6/s6_pr01_spec.md
```
