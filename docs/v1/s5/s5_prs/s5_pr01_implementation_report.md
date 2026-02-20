# S5 PR-01 Implementation Report

## 1. Summary of Changes

Six files touched, all within PR-01 deliverable scope:

| File | Change |
|---|---|
| `migrations/alembic/versions/0008_slice5_epub_toc_nodes.py` | New migration: creates `epub_toc_nodes` table with PK, 6 CHECK constraints, 2 FKs (self-referential parent + fragment), 2 indexes. Downgrade drops in reverse order. |
| `python/nexus/db/models.py` | New ORM model `EpubTocNode` under "Slice 5: EPUB" section. Maps all columns, CHECK constraints, and `media` relationship. No self-referential ORM relationships per decision ledger. |
| `python/nexus/db/__init__.py` | Added `EpubTocNode` to imports and `__all__` under "S5 Models" section. |
| `python/nexus/errors.py` | Added 4 error codes: `E_RETRY_INVALID_STATE` (409), `E_RETRY_NOT_ALLOWED` (409), `E_CHAPTER_NOT_FOUND` (404), `E_ARCHIVE_UNSAFE` (400). Added corresponding `ERROR_CODE_TO_STATUS` mappings. |
| `python/tests/test_migrations.py` | Added `TestS5Migration0008` class with 4 tests using self-managed migration state (matching S4 pattern). |
| `python/tests/test_errors.py` | Extended `test_error_code_maps_to_correct_status` parametrize list with 4 S5 error code assertions. |

## 2. Problems Encountered

| Problem | Resolution |
|---|---|
| Migration file import ordering failed `ruff` lint (I001) | Applied `ruff check --fix` to auto-sort imports. Root cause: ruff's isort rules differ from the hand-written import order used in 0007 (which passes because it was committed before ruff config tightened). |

No other problems encountered. Migration applied cleanly, all constraints enforced as specified, all pre-existing tests continued to pass.

## 3. Solutions Implemented

- **`epub_toc_nodes` table**: Exact structural match to L2 §2.2 SQL definition. Composite PK `(media_id, node_id)`. All 6 named CHECK constraints. Self-referential FK for parent hierarchy with CASCADE. Fragment FK is DEFERRABLE INITIALLY DEFERRED for bulk-insert ordering. Two indexes: unique on `(media_id, order_key)` and regular on `(media_id, fragment_idx)`.

- **ORM model**: Minimal surface per PR-01 decision ledger — only `media` relationship, no parent/children self-referential relationships (deferred to PR-04 service layer). CHECK constraints mirrored in `__table_args__` for ORM-level documentation.

- **Error codes**: 4 new enum values with category comments. Placed in new "S5 EPUB errors" section before ingestion errors. Status mappings added in same relative position in `ERROR_CODE_TO_STATUS` dict.

- **Migration tests**: `TestS5Migration0008` follows the S4 `TestS4Migration0007` pattern exactly: `isolate_migration` autouse fixture manages downgrade/upgrade lifecycle, dedicated `s5_engine` fixture, helper method for fixture creation. Tests cover: table/index existence, all constraint violations (7 invalid cases + 1 valid case), order_key format (3 valid + 5 invalid), unique order_key enforcement.

## 4. Decisions Made (and Why)

| Decision | Rationale |
|---|---|
| `order_key` format enforced at DB layer (not app-only) | Deterministic TOC ordering is a persisted invariant. DB guard prevents drift from parser/service code changes. Matches L4 decision ledger. |
| No self-referential ORM relationships | Prevents premature ORM graph complexity. Tree semantics belong in PR-04 service/query layer per roadmap ownership. |
| No endpoint payload types | PR-04 owns endpoint behavior; including types here creates hidden dependency. |
| Self-managed migration state in tests | Prevents false positives from shared fixtures. Ensures deterministic 0007→0008 contract verification. Matches S4 precedent. |
| DEFERRABLE INITIALLY DEFERRED on fragment FK | Enables bulk TOC node insertion where nodes may reference fragments inserted in the same transaction. Required for extraction pipeline in PR-02. |
| Explicit constraint names matching L2 spec exactly | Enables test assertions by constraint name and provides stable error diagnostics. |

## 5. Deviations from L4/L3/L2

None. Implementation is a strict subset of the L4 spec with no deviations.

- All constraint names match L2 §2.2 exactly.
- All error codes and status mappings match L2 §5 and L4 spec exactly.
- All test names and coverage match L4 acceptance tests section exactly.
- Only scoped files were touched per L4 constraints section.

## 6. Commands to Run New/Changed Behavior

```bash
# Apply the migration to dev database
make migrate

# Apply the migration to test database
make migrate-test

# Verify the table exists (psql)
psql postgresql://postgres:postgres@localhost:54322/postgres \
  -c "SELECT * FROM epub_toc_nodes LIMIT 0;"

# Verify new error codes exist (Python)
cd python && uv run python -c "from nexus.errors import ApiErrorCode; print(ApiErrorCode.E_ARCHIVE_UNSAFE)"
```

## 7. Commands Used to Verify Correctness

```bash
# Targeted S5 migration tests (4 tests)
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations" \
  NEXUS_ENV=test uv run pytest -v tests/test_migrations.py::TestS5Migration0008
# Result: 4 passed

# Targeted error mapping tests (32 tests including 4 new S5)
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test" \
  NEXUS_ENV=test uv run pytest -v tests/test_errors.py::TestErrorCodeToStatus
# Result: 32 passed

# Full migration test suite (regression check)
cd python && DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:54322/nexus_test_migrations" \
  NEXUS_ENV=test uv run pytest -v tests/test_migrations.py
# Result: 52 passed, 1 skipped (Redis connectivity, expected)

# Full verification (lint + format + typecheck + build + all tests)
make verify
# Result: All passed. Backend: 982 passed, 2 deselected. Migrations: 53 passed. Frontend: 294 passed (12 files).

# Lint check on touched files
cd python && uv run ruff check nexus/errors.py nexus/db/models.py nexus/db/__init__.py tests/test_errors.py tests/test_migrations.py
cd python && uv run ruff format --check nexus/errors.py nexus/db/models.py nexus/db/__init__.py tests/test_errors.py tests/test_migrations.py
# Result: All checks passed, all files formatted
```

## 8. Traceability Table

| Acceptance Item (from L4 spec) | Files | Tests | Status |
|---|---|---|---|
| `epub_toc_nodes` schema constraints and deterministic ordering storage rules are available | `0008_slice5_epub_toc_nodes.py`, `models.py`, `db/__init__.py` | `test_0008_epub_toc_nodes_table_and_indexes_exist`, `test_0008_epub_toc_nodes_constraints_enforced`, `test_0008_order_key_format_constraint`, `test_0008_unique_media_order_key_enforced` | PASS |
| S5-specific error/status mappings are defined in the platform error model | `errors.py` | `test_error_code_maps_to_correct_status[E_RETRY_INVALID_STATE-409]`, `[E_RETRY_NOT_ALLOWED-409]`, `[E_CHAPTER_NOT_FOUND-404]`, `[E_ARCHIVE_UNSAFE-400]`, `test_all_error_codes_have_status_mapping` | PASS |

## 9. Commit Message

```
feat(s5): add epub_toc_nodes schema and S5 error primitives (PR-01)

Land Slice 5 foundational contracts: the epub_toc_nodes persistence
schema and S5 API/error primitive registrations. This is the first PR
in the S5 EPUB sequence and provides the storage and error surface
that PR-02 through PR-07 build on.

Schema (migration 0008):
- Create epub_toc_nodes table with composite PK (media_id, node_id)
- 6 named CHECK constraints: node_id nonempty, parent nonself,
  label nonempty, depth range [0,16], fragment_idx nonneg,
  order_key format dddd(.dddd)*
- Self-referential FK (parent hierarchy) with ON DELETE CASCADE
- Fragment FK (media_id, fragment_idx) DEFERRABLE INITIALLY DEFERRED
- Unique index on (media_id, order_key) for deterministic TOC ordering
- Index on (media_id, fragment_idx) for chapter linkage queries

ORM:
- Add EpubTocNode model with media relationship (no self-ref ORM
  relationships; tree semantics deferred to PR-04 service layer)
- Export from nexus.db module

Error surface:
- E_RETRY_INVALID_STATE (409): retry on non-failed media
- E_RETRY_NOT_ALLOWED (409): retry blocked for terminal failures
- E_CHAPTER_NOT_FOUND (404): chapter index missing
- E_ARCHIVE_UNSAFE (400): archive safety violation

Tests:
- 4 migration tests: table/index existence, constraint enforcement
  (7 invalid + 1 valid case), order_key format (3 valid + 5 invalid),
  unique order_key enforcement
- 4 error mapping tests added to existing parametrize suite
- Full suite: 982 backend + 53 migration + 294 frontend = 0 failures

Refs: docs/v1/s5/s5_prs/s5_pr01.md
```
