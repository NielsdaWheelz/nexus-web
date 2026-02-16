# s4 pr-03 implementation report

## summary of changes

### `python/nexus/schemas/library.py`

added two request models:
- `UpdateLibraryMemberRequest` — `role: LibraryRole` field for PATCH member role.
- `TransferLibraryOwnershipRequest` — `new_owner_user_id: UUID` field for POST transfer-ownership.

both re-exported from `python/nexus/schemas/__init__.py` and added to `__all__`.

### `python/nexus/errors.py`

added `ConflictError(ApiError)` class mapping to HTTP 409. needed for `E_OWNERSHIP_TRANSFER_INVALID` which is a conflict-class error distinct from the existing `ForbiddenError`/`NotFoundError` hierarchy.

### `python/nexus/services/libraries.py`

**delete_library rewrite:**
- removed legacy single-member-only delete prohibition.
- owner-only: non-owner admins get `403 E_OWNER_REQUIRED`.
- non-members get masked `404 E_LIBRARY_NOT_FOUND`.
- default library still forbidden.
- uses `FOR UPDATE OF l` row lock during delete.

**new internal helpers:**
- `_fetch_library_with_membership(db, viewer_id, library_id, *, lock)` — fetches library metadata + viewer's membership in one query. raises masked `404` if viewer is not a member. optional `FOR UPDATE` on memberships.
- `_require_admin(role)` — raises `403 E_FORBIDDEN` if not admin.
- `_require_non_default(is_default)` — raises `403 E_DEFAULT_LIBRARY_FORBIDDEN` if default.
- `_repair_owner_admin_invariant(db, library_id, owner_user_id)` — ensures owner always has admin role; promotes if corrupted. runs inside the mutation transaction.

**new service functions:**
- `list_library_members` — admin-only. returns members sorted: owner first, then admin, then member, then `created_at ASC, user_id ASC`. limit clamped to [1, 200], default 100. allowed on default libraries.
- `update_library_member_role` — admin-only. enforces: default library forbidden, owner role immutable (`E_OWNER_EXIT_FORBIDDEN`), last-admin protection (`E_LAST_ADMIN_FORBIDDEN`), target must exist. idempotent when role unchanged. calls invariant repair.
- `remove_library_member` — admin-only. enforces: default library forbidden, owner immutable (`E_OWNER_EXIT_FORBIDDEN`), last-admin protection (`E_LAST_ADMIN_FORBIDDEN`). idempotent for absent targets (204). calls invariant repair.
- `transfer_library_ownership` — owner-only. enforces: default library forbidden, target must be existing member (else `409 E_OWNERSHIP_TRANSFER_INVALID`), idempotent when target is current owner. promotes target to admin, updates `owner_user_id`, bumps `updated_at`. previous owner stays admin. calls invariant repair.

### `python/nexus/api/routes/libraries.py`

added routes:
- `GET /libraries/{library_id}` — single library fetch for members, masked 404 for non-members.
- `GET /libraries/{library_id}/members` — list members (admin-only).
- `PATCH /libraries/{library_id}/members/{user_id}` — update member role (admin-only).
- `DELETE /libraries/{library_id}/members/{user_id}` — remove member (admin-only), 204.
- `POST /libraries/{library_id}/transfer-ownership` — transfer ownership (owner-only).

all routes are transport-only: single service call, envelope via `success_response(...)`.

### bff proxy routes (new files)

- `apps/web/src/app/api/libraries/[id]/members/route.ts` — `GET`
- `apps/web/src/app/api/libraries/[id]/members/[userId]/route.ts` — `PATCH`, `DELETE`
- `apps/web/src/app/api/libraries/[id]/transfer-ownership/route.ts` — `POST`

each: `runtime = "nodejs"`, direct `proxyToFastAPI(...)` passthrough, no domain logic.

### `apps/web/src/app/(authenticated)/libraries/page.tsx`

- fetches `viewerUserId` from `/api/me` alongside library list.
- delete button now only renders when `library.owner_user_id === viewerUserId` and library is non-default.
- backend remains final authority (`403 E_OWNER_REQUIRED` still enforced).

### `python/tests/test_libraries.py`

added ~40 new integration tests across 7 test classes:

| test class | count | coverage |
|---|---|---|
| `TestGetLibrary` | 2 | member access + non-member masked 404 |
| `TestDeleteLibraryGovernance` | 3 | owner multi-member delete, non-owner admin 403, non-member masked 404 |
| `TestListMembers` | 5 | ordering, limit/clamp, non-admin 403, non-member 404, default allowed |
| `TestUpdateMemberRole` | 8 | promote, idempotent, non-admin 403, non-member 404, target missing 404, owner exit 403, last-admin 403, default 403 |
| `TestRemoveMember` | 8 | success, idempotent 204, non-admin 403, non-member 404, owner exit 403, last-admin 403, default 403 |
| `TestTransferOwnership` | 9 | success + role preservation, idempotent, non-owner admin/member 403, non-member 404, default 403, non-member target 409, updated_at, transfer-then-exit |
| `TestGovernanceInvariantRepair` | 1 | corrupted owner role repaired by successful governance mutation |

all 853 tests pass.

---

## problems encountered

### 1. `ConflictError` class missing

the existing error hierarchy had `NotFoundError` (404), `ForbiddenError` (403), and `InvalidRequestError` (400/422), but no 409 class. `E_OWNERSHIP_TRANSFER_INVALID` maps to 409 in the status table but raising a generic `ApiError` wouldn't produce the right status code without a dedicated subclass.

**fix:** added `ConflictError(ApiError)` with default status 409. the existing `api_error_handler` catches `ApiError` subclasses generically, so no handler changes needed.

### 2. invariant repair test design flaw

the initial test for `_repair_owner_admin_invariant` corrupted the owner's role to `member`, then tried to trigger repair by having the owner call a governance endpoint. but after corruption, the owner's membership role is `member`, so `_require_admin` rejects them with `403`. the mutation fails, the transaction rolls back, and the repair is lost.

the core issue: invariant repair runs *inside* the transaction. if the business logic rejects the mutation, everything rolls back — including the repair. this is actually correct behavior. repair only matters when paired with a successful commit.

**fix:** redesigned the test to use three users (owner, admin, member). corrupt the owner's role, then have the *other admin* perform a successful mutation (promoting the member). the successful transaction commits both the promotion and the owner's invariant repair.

---

## solutions implemented

- **`ConflictError` class:** minimal addition to the error hierarchy. follows existing pattern (`ForbiddenError`, `NotFoundError`). default error code is `E_INVITE_NOT_PENDING` (most common 409 usage in s4), overridable by callers.

- **internal helper extraction:** `_fetch_library_with_membership`, `_require_admin`, `_require_non_default`, and `_repair_owner_admin_invariant` are private module-level functions. they reduce duplication across the 4 governance functions and make the auth/invariant logic testable via the public endpoints.

- **row locking strategy:** `_fetch_library_with_membership(lock=True)` adds `FOR UPDATE` on the memberships rows returned by the join. this prevents TOCTOU races on last-admin checks and owner-role checks during concurrent mutations.

- **invariant repair placement:** repair runs after the admin auth check but before business logic validation. this means it's within the transaction boundary of any successful mutation and lost on rollback (which is correct — you don't want to repair if the mutation itself is invalid).

---

## decisions made

1. **`GET /libraries/{id}/members` allowed on default libraries.** the spec says "default library membership mutation forbidden" but doesn't prohibit *reading* the member list. listing members is a read-only operation and useful for UI display. mutations (`PATCH`, `DELETE`) enforce the default-library prohibition.

2. **`_repair_owner_admin_invariant` as UPDATE...SET role='admin' with no-op on match.** rather than a conditional check-then-update, the function always runs the UPDATE. if the role is already `admin`, it's a no-op at the SQL level. simpler, fewer round trips.

3. **transfer idempotency: transfer to self returns 200 unchanged.** the spec says "if target already owner, return idempotent 200 unchanged." this is implemented as an early return before any row mutations, so `updated_at` is not bumped on no-op transfers.

4. **`ConflictError` default code is `E_INVITE_NOT_PENDING`.** this is the most frequently used 409 code in the s4 spec. callers explicitly pass the specific code they need (e.g., `E_OWNERSHIP_TRANSFER_INVALID`), so the default is just a reasonable fallback.

5. **non-member targets on transfer get `409 E_OWNERSHIP_TRANSFER_INVALID`, not `404`.** the spec explicitly says "unknown/non-member targets are both treated as `409 E_OWNERSHIP_TRANSFER_INVALID` (no user-existence oracle)." this avoids leaking whether a user_id exists.

---

## deviations from spec

none. implementation follows `s4_pr03.md` exactly:

- legacy single-member delete prohibition removed
- owner-only delete enforced with `E_OWNER_REQUIRED`
- all 4 member/transfer endpoints implemented with exact error codes
- owner-exit constraints use `E_OWNER_EXIT_FORBIDDEN`
- last-admin protection uses `E_LAST_ADMIN_FORBIDDEN`
- default-library mutation prohibition enforced on `PATCH/DELETE members` and `transfer-ownership`
- `GET members` ordering matches spec (owner first, admin, member, created_at ASC)
- bff proxy routes for all new endpoints
- ui delete button restricted to owner
- all specified test names implemented
- invariant repair hardening test included
- only files listed in deliverables were modified

---

## how to run new/changed commands

```bash
# run all backend tests (hermetic services)
make test-back

# run just library tests
make test-back && cd python && uv run pytest tests/test_libraries.py -v

# run full test suite (backend + migrations + frontend)
make test

# run full verification (lint + format + all tests)
make verify
```

---

## how to verify new/changed functionality

```bash
# start api server
make api

# --- member endpoints ---

# list members (admin-only)
curl -s http://localhost:8000/libraries/{library_id}/members \
  -H "Authorization: Bearer <token>" | jq

# update member role
curl -s -X PATCH http://localhost:8000/libraries/{library_id}/members/{user_id} \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}' | jq

# remove member
curl -s -X DELETE http://localhost:8000/libraries/{library_id}/members/{user_id} \
  -H "Authorization: Bearer <token>" -w "%{http_code}\n"

# --- ownership transfer ---

# transfer ownership
curl -s -X POST http://localhost:8000/libraries/{library_id}/transfer-ownership \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"new_owner_user_id": "<uuid>"}' | jq

# --- delete library (owner-only) ---

# non-owner admin gets 403 E_OWNER_REQUIRED
curl -s -X DELETE http://localhost:8000/libraries/{library_id} \
  -H "Authorization: Bearer <non-owner-admin-token>" | jq

# verify schemas importable
cd python && uv run python -c "from nexus.schemas import UpdateLibraryMemberRequest, TransferLibraryOwnershipRequest; print('ok')"

# verify ConflictError importable
cd python && uv run python -c "from nexus.errors import ConflictError; print('ok')"
```

---

## commit message

```
feat(s4): implement library governance — owner boundary, members, transfer (PR-03)

Implement S4 PR-03: library governance endpoints with strict
owner/admin separation, owner-exit constraints, and masked visibility.

Service layer changes (python/nexus/services/libraries.py):
- Replace legacy single-member delete prohibition with owner-only
  delete policy. Non-owner admins get 403 E_OWNER_REQUIRED. Non-members
  get masked 404 E_LIBRARY_NOT_FOUND.
- Add list_library_members: admin-only, sorted owner-first then by role
  rank then created_at. Limit clamped to [1, 200], default 100.
- Add update_library_member_role: admin-only, enforces owner
  immutability (E_OWNER_EXIT_FORBIDDEN), last-admin protection
  (E_LAST_ADMIN_FORBIDDEN), default-library prohibition. Idempotent
  when role unchanged.
- Add remove_library_member: admin-only, same constraints as update.
  Idempotent for absent targets (204).
- Add transfer_library_ownership: owner-only, target must be existing
  member (else 409 E_OWNERSHIP_TRANSFER_INVALID), promotes target to
  admin, previous owner stays admin, updates owner_user_id + updated_at.
  Idempotent when target is current owner.
- Add _repair_owner_admin_invariant: ensures owner always has admin
  role within mutation transactions.
- Add internal helpers: _fetch_library_with_membership (with optional
  FOR UPDATE locking), _require_admin, _require_non_default.

Schema additions (python/nexus/schemas/library.py):
- UpdateLibraryMemberRequest (role: LibraryRole)
- TransferLibraryOwnershipRequest (new_owner_user_id: UUID)
- Both re-exported from python/nexus/schemas/__init__.py

Error hierarchy (python/nexus/errors.py):
- Add ConflictError(ApiError) class for 409 status codes.

API routes (python/nexus/api/routes/libraries.py):
- GET /libraries/{library_id} (single library read, member-only)
- GET /libraries/{library_id}/members
- PATCH /libraries/{library_id}/members/{user_id}
- DELETE /libraries/{library_id}/members/{user_id}
- POST /libraries/{library_id}/transfer-ownership

BFF proxy routes (apps/web/src/app/api/libraries/):
- [id]/members/route.ts (GET)
- [id]/members/[userId]/route.ts (PATCH, DELETE)
- [id]/transfer-ownership/route.ts (POST)

Frontend (apps/web/src/app/(authenticated)/libraries/page.tsx):
- Fetch viewerUserId from /api/me to conditionally render delete
  button only for library owner on non-default libraries.

Tests (python/tests/test_libraries.py):
- ~40 new integration tests across 7 test classes covering: GET single
  library, owner-only delete governance, list members ordering/auth,
  update member role (promote, idempotent, forbidden paths), remove
  member (success, idempotent, forbidden paths), ownership transfer
  (success, idempotent, forbidden paths, updated_at, transfer-then-exit),
  and owner-admin invariant repair.
- All 853 backend tests pass.

No invite lifecycle endpoints (PR-04). No closure/backfill logic (PR-05).
No conversation/highlight/search contract changes.
```
