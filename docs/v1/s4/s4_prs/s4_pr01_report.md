# s4 pr-01 implementation report

## summary of changes

### migration: `0007_slice4_library_sharing.py`

new alembic migration (revision `0007`, down_revision `0006`) that:

1. **precheck** — queries `memberships` + `libraries` to hard-fail with `S4_0007_MISSING_DEFAULT_LIBRARY` if any member of a non-default library lacks a default library. runs before any DDL.

2. **creates 4 new tables:**
   - `library_invitations` — invitation lifecycle (pending/accepted/declined/revoked) with 4 check constraints (`ck_library_invitations_role`, `ck_library_invitations_status`, `ck_library_invitations_not_self`, `ck_library_invitations_responded_at`), partial unique index for one-pending-per-pair, and 2 composite indexes for list queries.
   - `default_library_intrinsics` — tracks media intentionally in a default library (user intent), composite PK `(default_library_id, media_id)`.
   - `default_library_closure_edges` — tracks which shared-library memberships justify default-library materialization, composite PK `(default_library_id, media_id, source_library_id)`.
   - `default_library_backfill_jobs` — durable backfill intent for async closure materialization, composite PK `(default_library_id, source_library_id, user_id)`, with `ck_default_library_backfill_jobs_status`, `ck_default_library_backfill_jobs_attempts`, and `ck_default_library_backfill_jobs_finished_at_state` constraints.

3. **adds 3 supporting indexes on existing tables:**
   - `idx_memberships_user_library_role` on `memberships (user_id, library_id, role)`
   - `idx_library_media_media_library` on `library_media (media_id, library_id)`
   - `idx_conversation_shares_library_conversation` on `conversation_shares (library_id, conversation_id)`

4. **deterministic seed transform (s4 spec §3.7):**
   - seeds closure edges by joining `memberships → non-default libraries → library_media → owner's default library`
   - seeds intrinsics for any default `library_media` row not covered by a closure edge
   - all inserts use `ON CONFLICT DO NOTHING` for idempotency
   - does NOT seed `default_library_backfill_jobs`

5. **downgrade** — drops indexes on existing tables, then drops all 4 new tables in reverse order.

### orm models: `python/nexus/db/models.py`

added 3 python enums:
- `LibraryInvitationRole(str, PyEnum)` — `admin`, `member`
- `LibraryInvitationStatus(str, PyEnum)` — `pending`, `accepted`, `declined`, `revoked`
- `DefaultLibraryBackfillJobStatus(str, PyEnum)` — `pending`, `running`, `completed`, `failed`

added 4 orm classes:
- `LibraryInvitation` — maps `library_invitations` with relationships to `Library`, inviter/invitee `User`
- `DefaultLibraryIntrinsic` — maps `default_library_intrinsics`
- `DefaultLibraryClosureEdge` — maps `default_library_closure_edges`
- `DefaultLibraryBackfillJob` — maps `default_library_backfill_jobs`

all table names, pk/fk columns, and constraint names match the migration exactly.

### exports: `python/nexus/db/__init__.py`

added all 3 new enums and 4 new model classes to both import list and `__all__`.

### error codes: `python/nexus/errors.py`

added 9 new `ApiErrorCode` members with `ERROR_CODE_TO_STATUS` mappings:

| code | http |
|---|---|
| `E_USER_NOT_FOUND` | 404 |
| `E_INVITE_NOT_FOUND` | 404 |
| `E_INVITE_ALREADY_EXISTS` | 409 |
| `E_INVITE_MEMBER_EXISTS` | 409 |
| `E_INVITE_NOT_PENDING` | 409 |
| `E_OWNER_REQUIRED` | 403 |
| `E_OWNER_EXIT_FORBIDDEN` | 403 |
| `E_OWNERSHIP_TRANSFER_INVALID` | 409 |
| `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN` | 403 |

### schemas: `python/nexus/schemas/library.py`

added typed aliases:
- `LibraryRole = Literal["admin", "member"]`
- `LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]`

added response schemas:
- `LibraryMemberOut` — `user_id`, `role`, `is_owner`, `created_at`
- `LibraryInvitationOut` — `id`, `library_id`, `inviter_user_id`, `invitee_user_id`, `role`, `status`, `created_at`, `responded_at`

both re-exported from `python/nexus/schemas/__init__.py`.

### tests

**`python/tests/test_errors.py`** — extended parametrized test with all 9 new error codes and expected statuses.

**`python/tests/test_migrations.py`** — new `TestS4Migration0007` class with 8 tests:

1. `test_upgrade_0006_to_0007_seeds_edges_and_intrinsics` — verifies seed produces correct closure edges and intrinsics from fixture data with overlapping default/non-default media.
2. `test_upgrade_0006_to_0007_fails_when_member_has_no_default_library` — verifies hard-fail precheck with `S4_0007_MISSING_DEFAULT_LIBRARY` sentinel.
3. `test_upgrade_0006_to_0007_seed_is_idempotent_after_downgrade_round_trip` — verifies PK tuple sets are identical after downgrade + re-upgrade.
4. `test_0007_supporting_indexes_exist` — queries `pg_indexes` for all 10 expected index names.
5. `test_library_invitations_pending_unique_partial_index` — verifies `uix_library_invitations_pending_once` rejects duplicate pending invites.
6. `test_library_invitations_responded_at_check_constraint` — verifies `ck_library_invitations_responded_at` rejects invalid status/responded_at combos.
7. `test_library_invitations_not_self_check_constraint` — verifies `ck_library_invitations_not_self` rejects self-invites.
8. `test_default_library_backfill_jobs_finished_at_state_constraint` — verifies `ck_default_library_backfill_jobs_finished_at_state` rejects invalid status/finished_at combos.

all S4 tests are self-isolated: they downgrade to base before each test and restore to head after.

---

## problems encountered

1. **alembic `create_index` with DESC columns** — alembic's `create_index` doesn't natively support `DESC` column ordering in the column list. solved by passing `sa.text("created_at DESC")` and `sa.text("id DESC")` as column expressions.

2. **test isolation with module-scoped `migrated_engine`** — the existing test file uses a module-scoped fixture that upgrades to head once. S4 tests that downgrade to 0006 mid-test would corrupt this state for later tests. solved by adding `upgrade head` in the S4 test teardown fixture, so state is always restored.

3. **pre-existing test failures** — `test_keys.py` and `test_models.py` have pre-existing failures related to `user_api_keys.encrypted_key` NOT NULL constraint when revoking keys. these are completely unrelated to S4 and were present before this PR.

---

## solutions implemented

- **precheck-before-DDL pattern**: run the data integrity check before creating any tables. this means if the precheck fails, no schema changes are applied and the migration is cleanly abortable.

- **set-based seed inserts**: both seed steps use single INSERT...SELECT statements with `ON CONFLICT DO NOTHING`, making them idempotent and efficient regardless of data volume.

- **defensive test teardown**: S4 tests always restore migration state to head after completion, preventing interference with other test classes in the same module.

---

## decisions made

1. **precheck runs before DDL, not between DDL and seed**: ensures no partial schema changes if data is inconsistent.

2. **no postgres enum types for new columns**: used `Text` + `CHECK` constraints (same pattern as existing `memberships.role`). avoids `ALTER TYPE` complexity for future value additions.

3. **separate `LibraryInvitationRole` enum**: created as distinct from `MembershipRole` even though values are identical. separate enums allow independent evolution and provide better type clarity.

4. **`Literal` types for pydantic schemas**: used `Literal["admin", "member"]` etc. for response models (not the python enum types). this produces cleaner JSON serialization and explicit string values in OpenAPI schemas.

5. **no relationships on provenance tables**: `DefaultLibraryIntrinsic`, `DefaultLibraryClosureEdge`, and `DefaultLibraryBackfillJob` have no SQLAlchemy relationship definitions. these tables are operated on via raw queries or simple ORM operations; speculative relationship helpers would add complexity with no current consumer.

---

## deviations from spec

none. implementation follows `s4_pr01.md` exactly:
- all 4 tables created with specified columns, constraints, and indexes
- seed logic follows s4 spec §3.7 steps 1-3 exactly
- precheck uses sentinel string `S4_0007_MISSING_DEFAULT_LIBRARY`
- all 9 error codes added with correct HTTP statuses
- all schema types match spec field-by-field
- all 8 specified tests implemented and passing
- only files listed in deliverables were modified

---

## how to run new/changed commands

```bash
# run migration (applies 0007)
make migrate

# run migration on test database
make migrate-test

# run error code tests
source .env && cd python && DATABASE_URL="$DATABASE_URL_TEST" NEXUS_ENV=test \
  uv run pytest -v tests/test_errors.py

# run migration tests (uses separate migration test database)
source .env && cd python && DATABASE_URL="$DATABASE_URL_TEST_MIGRATIONS" NEXUS_ENV=test \
  uv run pytest -v tests/test_migrations.py

# run migration tests via makefile (hermetic services)
make test-migrations

# run all backend tests (hermetic services)
make test-back

# run just the S4 migration tests
source .env && cd python && DATABASE_URL="$DATABASE_URL_TEST_MIGRATIONS" NEXUS_ENV=test \
  uv run pytest -v tests/test_migrations.py::TestS4Migration0007
```

---

## how to verify new/changed functionality

```bash
# verify migration applies cleanly
source .env && cd migrations && uv run --project ../python alembic upgrade head

# verify migration downgrades cleanly
source .env && cd migrations && uv run --project ../python alembic downgrade 0006

# verify new tables exist
psql "$DATABASE_URL" -c "\dt library_invitations"
psql "$DATABASE_URL" -c "\dt default_library_intrinsics"
psql "$DATABASE_URL" -c "\dt default_library_closure_edges"
psql "$DATABASE_URL" -c "\dt default_library_backfill_jobs"

# verify new indexes exist
psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%' AND schemaname = 'public' ORDER BY indexname;"

# verify error codes importable
cd python && uv run python -c "from nexus.errors import ApiErrorCode; print(ApiErrorCode.E_OWNER_REQUIRED)"

# verify schemas importable
cd python && uv run python -c "from nexus.schemas import LibraryMemberOut, LibraryInvitationOut; print('ok')"

# verify ORM models importable
cd python && uv run python -c "from nexus.db import LibraryInvitation, DefaultLibraryIntrinsic, DefaultLibraryClosureEdge, DefaultLibraryBackfillJob; print('ok')"
```

---

## commit message

```
feat(s4): add library sharing schema, error codes, and type contracts (PR-01)

Implement S4 PR-01: the full data contract for library sharing.

Migration 0007 creates four new tables for the sharing subsystem:
- library_invitations: invite lifecycle with pending/accepted/declined/revoked
  states, partial unique index for one-pending-per-pair, responded_at/status
  consistency constraint, and self-invite prevention
- default_library_intrinsics: tracks media intentionally present in a user's
  default library independent of shared-library membership
- default_library_closure_edges: tracks which shared-library memberships
  justify default-library materialization (provenance tracking)
- default_library_backfill_jobs: durable backfill intent for async closure
  materialization with status/finished_at state consistency constraint

The migration also adds three supporting indexes on existing tables
(memberships, library_media, conversation_shares) for the visibility
queries that later S4 PRs will introduce.

A deterministic seed transform (s4 spec §3.7) populates closure edges
from existing non-default library memberships and classifies remaining
default-library media as intrinsics. A hard-fail precheck prevents
migration if any non-default library member lacks a default library.

Adds 9 new API error codes (E_USER_NOT_FOUND, E_INVITE_NOT_FOUND,
E_INVITE_ALREADY_EXISTS, E_INVITE_MEMBER_EXISTS, E_INVITE_NOT_PENDING,
E_OWNER_REQUIRED, E_OWNER_EXIT_FORBIDDEN, E_OWNERSHIP_TRANSFER_INVALID,
E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN) with HTTP status mappings.

Adds ORM models (LibraryInvitation, DefaultLibraryIntrinsic,
DefaultLibraryClosureEdge, DefaultLibraryBackfillJob) and Python enums
(LibraryInvitationRole, LibraryInvitationStatus,
DefaultLibraryBackfillJobStatus).

Adds Pydantic response schemas (LibraryMemberOut, LibraryInvitationOut)
with Literal type aliases for role and invitation status values.

Includes 8 self-isolated migration tests covering seed correctness,
precheck failure, seed idempotency after round-trip, index existence,
and all new check/unique constraints. All 42 error tests and 760+
existing backend tests remain green.

No endpoint behavior changes. No visibility predicate rewrites. No
service logic changes. Schema and types only.
```
