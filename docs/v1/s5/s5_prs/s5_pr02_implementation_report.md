# S5 PR-02 Implementation Report: EPUB Extraction Artifacts

## 1. Summary of Changes

Implemented deterministic EPUB extraction artifact materialization as a reusable domain executor with no endpoint orchestration changes.

**New files:**
- `python/nexus/services/epub_ingest.py` — Core extraction service: archive safety, OPF/spine/manifest/NCX/nav parsing, chapter fragment materialization, fragment block generation, TOC snapshot, title fallback, resource rewriting, atomic persistence.
- `python/nexus/tasks/ingest_epub.py` — Celery task wrapper + `run_epub_ingest_sync` test helper.
- `python/tests/test_epub_ingest.py` — 8 integration tests with in-memory EPUB fixture builders.
- `python/tests/test_config.py` — 3 archive safety config tests.

**Modified files:**
- `python/nexus/config.py` — 5 archive safety config keys with L2-baseline floor validation.
- `python/nexus/services/media.py` — `get_epub_asset_for_viewer` service function + `EpubAssetOut` dataclass.
- `python/nexus/api/routes/media.py` — `GET /media/{media_id}/assets/{asset_key:path}` binary endpoint.
- `python/nexus/tasks/__init__.py` — Registered `ingest_epub` task.
- `python/tests/test_upload.py` — Regression test for response shape (no PR-03 fields).
- `python/tests/test_media.py` — 3 asset endpoint tests (success/masking, kind guard, ready guard).
- `README.md` — New endpoint, config vars, feature description.

## 2. Problems Encountered

| # | Problem | Impact |
|---|---------|--------|
| 1 | `fragment_blocks` has no `media_id` column; test helper's `_count("fragment_blocks", media_id)` failed with ProgrammingError | Blocked test execution |
| 2 | `get_storage_client` patched at wrong module path (`nexus.services.media`) instead of import site (`nexus.storage`) | Asset endpoint tests failed with AttributeError |
| 3 | Atomicity test mocking `db.flush()` was fragile — SQLAlchemy calls flush internally at unpredictable points | Flaky atomicity test |
| 4 | Lint errors: `zip()` without `strict=True` (B905), unused variables (F841), `raise` without `from` (B904), unsorted imports (I001) | CI gate failures |
| 5 | `pytest tests/test_config.py` directly fails because `DATABASE_URL` isn't set outside `make` wrapper | Test environment setup |

## 3. Solutions Implemented

| # | Solution |
|---|----------|
| 1 | Changed `_count` helper to JOIN `fragment_blocks` through `fragments` table when counting blocks by media_id |
| 2 | Corrected mock target to `nexus.storage.get_storage_client` (the module where the import resolves) |
| 3 | Replaced `db.flush()` mock with targeted patch on `nexus.services.epub_ingest.insert_fragment_blocks` — deterministic failure point after fragments added but before commit |
| 4 | Fixed all lint issues: added `strict=True`, removed unused vars/imports, added `from exc`, ran `make fmt-back` |
| 5 | Used `make test-back ARGS="-k ..."` which sources `scripts/test_env.sh` for proper environment setup |

## 4. Decisions Made

| Decision | Why |
|----------|-----|
| Python-native parser (`zipfile` + `lxml`) | Single-runtime control, no external EPUB framework dependency, deterministic behavior, testable under existing CI/CD |
| Atomic single-transaction writes | Eliminates partial-generation states; downstream retry/read guarantees are trivially correct |
| `node_id` = nav-id → href → label-slug with sibling disambiguation and hierarchical path composition | Stable across parser variance; no external state needed for deterministic identity |
| Asset key = normalized EPUB path (fragment stripped) | Refs differing only by URL fragment map to same storage object — correct dedup semantics |
| Missing TOC = non-fatal (0 rows) | Real-world EPUBs frequently lack usable TOC; blocking extraction is wrong |
| Unresolved internal assets = non-fatal degradation | Broken asset refs in source EPUB shouldn't block readable text extraction |
| Archive safety = hard pre-parse gate | Security baseline enforced before any content touches memory |
| Config floor validation (runtime ≤ L2 baseline) | Operators can tighten limits, never weaken below L2 security floor |
| `insert_fragment_blocks` as test seam for atomicity | More reliable than mocking SQLAlchemy session internals; deterministic failure injection point |

## 5. Deviations from L4/L3/L2

**None.** Implementation follows the spec as written. All deliverable files match spec ownership boundaries (C3 only). No out-of-scope changes.

## 6. Commands to Run New/Changed Behavior

```bash
# Run EPUB extraction (via sync helper in tests)
make test-back ARGS="-k test_epub_extract_materializes"

# Serve an EPUB asset (requires running server + valid media)
curl -H "Authorization: Bearer <token>" \
  http://localhost:8000/media/<media_id>/assets/OEBPS/images/cover.jpg

# Verify archive safety rejection
make test-back ARGS="-k test_epub_extract_rejects_unsafe"

# Verify config floor enforcement
make test-back ARGS="-k test_epub_archive_safety"
```

## 7. Commands Used to Verify Correctness

```bash
# Full verification suite (all linters + all tests)
make verify
# Result: Exit code 0 — "All verification checks passed!"
# Backend: 1009 passed | Frontend: 294 passed

# Targeted extraction tests
make test-back ARGS="-k test_epub"
# Result: 12 passed

# Targeted asset endpoint tests
make test-back ARGS="-k TestGetEpubAsset"
# Result: 3 passed

# Targeted config tests
make test-back ARGS="-k test_epub_archive_safety"
# Result: 3 passed

# Targeted upload regression
make test-back ARGS="-k test_ingest_response_keys"
# Result: 1 passed

# Lint check
make lint-back
# Result: clean

# Format check
make fmt-back
# Result: clean
```

## 8. Traceability Table

| Acceptance Item | Files | Tests | Status |
|-----------------|-------|-------|--------|
| Contiguous spine-order fragment materialization with fragment blocks | `epub_ingest.py`, `ingest_epub.py` | `test_epub_extract_materializes_contiguous_spine_fragments_and_blocks` | ✅ PASS |
| Deterministic TOC snapshot with stable node_id and order_key | `epub_ingest.py` | `test_epub_extract_persists_deterministic_toc_snapshot` | ✅ PASS |
| Missing TOC is non-fatal | `epub_ingest.py` | `test_epub_extract_missing_toc_is_non_fatal` | ✅ PASS |
| Title fallback: dc:title → title → filename → "Untitled EPUB" | `epub_ingest.py` | `test_epub_extract_title_fallback_filename_then_literal` | ✅ PASS |
| Resource rewriting + degradation for unresolved assets | `epub_ingest.py`, `media.py`, `routes/media.py` | `test_epub_extract_rewrites_resources_and_degrades_unresolved_assets` | ✅ PASS |
| Archive safety rejection with E_ARCHIVE_UNSAFE | `epub_ingest.py`, `config.py` | `test_epub_extract_rejects_unsafe_archive_with_terminal_code` | ✅ PASS |
| Failure classification matrix (E_SANITIZATION_FAILED, E_INGEST_FAILED) | `epub_ingest.py` | `test_epub_extract_failure_classification_matrix` | ✅ PASS |
| Atomic artifact commits (no partial writes) | `epub_ingest.py` | `test_epub_extract_commits_artifacts_atomically` | ✅ PASS |
| Asset endpoint: success + visibility masking | `media.py`, `routes/media.py` | `test_get_epub_asset_success_and_masking` | ✅ PASS |
| Asset endpoint: kind and ready guards | `media.py`, `routes/media.py` | `test_get_epub_asset_kind_and_ready_guards` | ✅ PASS |
| Config: L2 defaults + floor validation | `config.py` | `test_epub_archive_safety_config_defaults_and_floor_validation` | ✅ PASS |
| Response shape regression (no PR-03 fields) | `test_upload.py` | `test_ingest_response_keys` | ✅ PASS |
| Only scoped files touched | — | `make verify` (route structure test green) | ✅ PASS |
| No lifecycle/orchestration changes (PR-03 boundary) | — | No `processing_status` mutations in extraction code | ✅ PASS |

## 9. Commit Message

```
feat(s5-pr02): implement EPUB extraction artifact materialization

Implement deterministic EPUB extraction as a reusable domain executor
(C3 ownership) with no endpoint orchestration changes.

Core extraction service (epub_ingest.py):
- Parse EPUB archives via zipfile + lxml (no external EPUB framework)
- Enforce archive safety (path traversal, entry count, size, compression
  ratio, parse time) as hard pre-parse gate with E_ARCHIVE_UNSAFE
- Extract chapter fragments in spine order with contiguous idx 0..N-1
- Generate fragment blocks from immutable canonical_text per fragment
- Materialize deterministic TOC snapshot into epub_toc_nodes with stable
  node_id generation (nav-id -> href -> label-slug, sibling disambiguation,
  hierarchical path composition, hash-tail shortening at 255 chars)
- Resolve media title via fallback chain: dc:title -> title -> filename
  sans extension -> "Untitled EPUB" (normalized, truncated to 255 chars)
- Rewrite internal asset refs to canonical safe-fetch paths
  (/media/{id}/assets/{key}), external images to image proxy
- Persist all artifacts atomically in single transaction; rollback on
  any failure leaves zero partial writes

Asset fetch (media.py, routes/media.py):
- GET /media/{media_id}/assets/{asset_key:path} binary endpoint
- Visibility masking (404), kind guard (400), ready guard (409)
- Stream bytes from storage with content-type and cache headers

Configuration (config.py):
- 5 archive safety config keys with L2 baseline defaults
- Floor validation: runtime values may be stricter, never weaker

Task wrapper (ingest_epub.py):
- Celery task ingest_epub (max_retries=0)
- Sync helper run_epub_ingest_sync for deterministic tests

Tests (15 new):
- 8 extraction integration tests covering fragment materialization,
  TOC determinism, missing TOC, title fallback, resource rewriting,
  archive safety, failure classification, atomic commits
- 3 asset endpoint tests (success/masking, kind guard, ready guard)
- 3 config tests (defaults, strict overrides, floor rejection)
- 1 upload regression test (response shape unchanged)

All tests pass (make verify: 1009 backend + 294 frontend, zero lint).

Refs: docs/v1/s5/s5_prs/s5_pr02.md
```
