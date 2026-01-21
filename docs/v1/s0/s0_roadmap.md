# Nexus — Slice 0 PR Roadmap (L3)

This document breaks Slice 0 into a sequence of mergeable pull requests.
Each PR is:
- reviewable in isolation
- test-backed (tests land with the code they test)
- dependency-ordered
- safe to merge to main

No PR may violate the Slice 0 spec (`s0_spec.md`) or the constitution.

---

## PR-01 — Backend Platform + DB Schema

**Goal:** Establish backend foundation, database, and infrastructure before any domain logic.

### Includes
- FastAPI bootstrap
- Settings + environment loading
- Error model + `{data}/{error}` envelope
- DB engine/session/transaction helpers
- Alembic setup + Slice 0 migrations
- Health endpoint (`GET /health`)

### Backend Changes
- `app/main.py`: FastAPI app creation
- `app/settings.py`: Pydantic settings
  - `NEXUS_ENV` (local | test | staging | prod)
  - `NEXUS_INTERNAL_SECRET`
  - `DATABASE_URL`
- `app/errors.py`:
  - `ApiError` base class
  - `ApiErrorCode` enum (all E_* codes from spec)
  - error code → HTTP status mapping
- Global exception handler:
  - always returns `{ "error": { "code", "message" } }`
- Success helper:
  - returns `{ "data": ... }`
- `app/db/engine.py`:
  - create_engine with connection pooling
  - sessionmaker configuration
- `app/db/session.py`:
  - `get_db()` dependency (request-scoped)
  - `transaction()` context manager
- `app/db/testing.py`:
  - test fixture that uses nested transactions (savepoints)
  - auto-rollback after each test
- `alembic/versions/xxxx_slice0_schema.py`:
  - `users`
  - `libraries` (with partial unique index for default)
  - `memberships`
  - `media`
  - `fragments`
  - `library_media`
- `GET /health` endpoint (returns `{ "data": { "status": "ok" } }`)

### Tests
- Unit tests for error → HTTP mapping
- Unit tests for envelope shape
- Migration applies cleanly to empty DB
- Migration rollback works
- Constraints enforced:
  - duplicate default library rejected
  - duplicate membership rejected
- DB smoke test: opens session, runs `SELECT 1`

### Acceptance
- App boots
- All responses are enveloped
- Errors are consistent and typed
- `alembic upgrade head` succeeds
- Schema exactly matches spec
- Every request gets isolated session
- Test isolation via rollback works

---

## PR-02 — Auth Boundary + Bootstrap + Test Harness

**Goal:** Lock down authentication, guarantee identity/default-library invariants, establish test infrastructure.

### Includes
- Token verifier abstraction
- Supabase JWKS verifier (prod)
- Test verifier (tests only)
- Internal header enforcement by environment
- Auth middleware with `viewer_user_id` injection
- `ensure_user_and_default_library` + middleware hook
- Minimal `/me` endpoint
- Test helpers for minting tokens and auth headers

### Backend Changes
- `app/auth/verifier.py`:
  - `TokenVerifier` interface
  - `SupabaseJwksVerifier`:
    - JWKS cache TTL: 1 hour
    - Refresh-on-kid-miss: if `kid` not in cache, refresh once then fail
    - Clock skew allowance: 60 seconds for `exp`
  - `TestTokenVerifier`
- `app/auth/middleware.py`:
  - bearer token validation
  - `viewer_user_id` injection into request state
  - `X-Nexus-Internal` enforcement:
    - required if `NEXUS_ENV ∈ {staging, prod}`
- Startup validation:
  - missing secret in staging/prod → crash
- `app/services/bootstrap.py`:
  - `ensure_user_and_default_library(user_id)` (race-safe)
- Middleware hook after auth calls bootstrap function
- `app/api/me.py`:
  - `GET /me` returns `{ user_id, default_library_id }`
- `tests/helpers.py`:
  - `mint_test_token(user_id)` → JWT string
  - `auth_headers(user_id)` → dict with Authorization header
  - `create_test_user()` → user_id

### Tests
- Missing token → 401 `E_UNAUTHENTICATED`
- Invalid token → 401 `E_UNAUTHENTICATED`
- Expired token → 401 `E_UNAUTHENTICATED`
- Missing internal header (NEXUS_ENV=staging) → 403 `E_INTERNAL_ONLY`
- Internal header ignored in local/test
- Unit test: kid-miss triggers JWKS refresh
- First `/me` call creates:
  - user row
  - default library named "My Library"
  - owner admin membership
- Concurrent first requests → exactly one default library
- Partial failure recovery: missing membership repaired on next request

### Acceptance
- No endpoint reachable without valid auth (except /health)
- BFF-only invariant enforced in staging/prod
- JWKS caching works correctly
- Default library always exists after first authenticated request
- Invariant holds under race conditions

---

## PR-03 — Libraries + Membership Rules + Library-Media

**Goal:** Implement all library domain logic and routes.

### Includes
- Library service layer (CRUD, membership enforcement, closure logic)
- All library and library-media routes
- Pydantic request/response schemas (inline with routes)

### Backend Changes
- `app/services/libraries.py`:
  - `create_library(viewer_id, name)` → creates library + owner membership
  - `rename_library(viewer_id, library_id, name)` → admin only, forbid default
  - `delete_library(viewer_id, library_id)` → admin only, forbid default, cascade allowed
  - `list_libraries(viewer_id)` → libraries where viewer is member
  - `get_library(viewer_id, library_id)` → 404 if not member
  - `add_media_to_library(viewer_id, library_id, media_id)` → admin only, closure enforced
  - `remove_media_from_library(viewer_id, library_id, media_id)` → admin only, closure enforced
  - `list_library_media(viewer_id, library_id)` → 404 if not member
- All mutations wrapped in transactions
- `app/schemas/library.py`:
  - `LibraryResponse`
  - `LibraryCreateRequest`
  - `LibraryUpdateRequest`
  - `LibraryMediaResponse`
  - `AddMediaRequest`
- `app/api/libraries.py`:
  - `GET /libraries` (limit default 100, max 200)
  - `POST /libraries`
  - `PATCH /libraries/{id}`
  - `DELETE /libraries/{id}`
  - `GET /libraries/{id}/media` (limit default 100, max 200)
  - `POST /libraries/{id}/media`
  - `DELETE /libraries/{id}/media/{media_id}`

### Enforcement
- **No raw SQL in routes rule:**
  - Routes only import service functions
  - Add CODEOWNERS rule: `app/api/*.py` requires review if importing `sqlalchemy` or `app/db`
  - Test that route modules don't import DB directly

### Tests
- Create library → owner becomes admin
- Rename library → success for admin, 403 for member
- Rename default library → 403 `E_DEFAULT_LIBRARY_FORBIDDEN`
- Delete library → success for admin, cascades library_media + memberships
- Delete default library → 403 `E_DEFAULT_LIBRARY_FORBIDDEN`
- List libraries → only returns libraries where viewer is member
- Get library → 404 for non-member
- Add media to library → closure inserts into all members' default libraries
- Remove media from default library → cascades to single-member libraries
- Remove media from non-default → does not affect default library
- 404 masking for non-member access
- Ordering: `created_at asc, id asc` for libraries; `created_at desc, id desc` for media
- Limits enforced (default 100, max 200)
- `E_NAME_INVALID` for empty/long names

### Acceptance
- All library invariants enforced in service layer
- No direct DB access from routes (enforced)
- API matches spec for all library endpoints

---

## PR-04 — Media/Fragments Routes + Full Slice-0 Test Suite

**Goal:** Complete API surface, seed fixtures, run full test suite.

### Includes
- Media and fragments routes
- Fixture media + fragment seeding
- Full 26-scenario test suite
- Any hardening fixes found during testing

### Backend Changes
- `app/schemas/media.py`:
  - `MediaResponse`
  - `FragmentResponse`
- `app/api/media.py`:
  - `GET /media/{id}` → 404 if not readable
  - `GET /media/{id}/fragments` → 404 if not readable, ordered by `idx asc`
- `tests/fixtures.py`:
  - `FIXTURE_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")`
  - `FIXTURE_FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")`
  - `seeded_media` pytest fixture (creates web_article + fragment)
- Visibility masking: media not in any of viewer's libraries → 404
- Guarantee: no endpoint ever returns unsanitized HTML

### Tests — Full FastAPI Scenario Suite (20)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Unauthenticated request | 401 `E_UNAUTHENTICATED` |
| 2 | Invalid token | 401 `E_UNAUTHENTICATED` |
| 3 | Missing internal header (NEXUS_ENV=staging) | 403 `E_INTERNAL_ONLY` |
| 4 | First login creates user + default library | User and library created |
| 5 | Concurrent first logins are race-safe | No duplicate libraries |
| 6 | Default library name is "My Library" | Verified |
| 7 | Cannot delete default library | 403 `E_DEFAULT_LIBRARY_FORBIDDEN` |
| 8 | Cannot rename default library | 403 `E_DEFAULT_LIBRARY_FORBIDDEN` |
| 9 | Admin can delete non-default library | Success with cascade |
| 10 | Non-admin cannot delete library | 403 `E_FORBIDDEN` |
| 11 | Non-member cannot read library (404) | 404 `E_LIBRARY_NOT_FOUND` |
| 12 | Non-member cannot read media | 404 `E_MEDIA_NOT_FOUND` |
| 13 | Default library closure on add | Media in default library |
| 14 | Default library closure on remove | Cascades to single-member libs |
| 15 | Last admin cannot be removed | 403 `E_LAST_ADMIN_FORBIDDEN` |
| 16 | Owner membership cannot be removed | 403 `E_FORBIDDEN` |
| 17 | Media listing has stable ordering | Order by created_at desc, id desc |
| 18 | Library deletion cascades library_media | Verified |
| 19 | GET /media/{id} enforces visibility | 404 for non-readable |
| 20 | GET /media/{id}/fragments returns content | html_sanitized present |

### Tests — Visibility Closure Scenarios (6)

| # | Scenario | Expected |
|---|----------|----------|
| V1 | User A adds media M to library LA | A can read M |
| V2 | User B (no membership in LA) tries to read M | 404 `E_MEDIA_NOT_FOUND` |
| V3 | User A creates new library LB, does NOT add M | A can still read M (closure) |
| V4 | User A removes M from default library | M removed from all A's single-member libs |
| V5 | After V4, User A tries to read M | 404 `E_MEDIA_NOT_FOUND` |
| V6 | User B adds same media M to their library | B can read; A still cannot |

### Acceptance
- All 26 FastAPI scenarios pass
- No visibility leaks
- Tests pass deterministically
- `GET /media/{id}/fragments` returns `html_sanitized` and `canonical_text`
- Media not in any of user's libraries → 404

---

## PR-05 — Next.js BFF + UI Shell + Onboarding

**Goal:** Complete the browser layer, prove end-to-end, document for onboarding.

### Includes
- BFF proxy routes
- UI shell (navbar, tabsbar, panes, pages)
- Documentation and scripts

### Frontend Changes — BFF Proxy
- Route handlers mirror FastAPI paths (no `/proxy/` in URL):
  - `app/api/me/route.ts` → FastAPI `/me`
  - `app/api/libraries/route.ts` → FastAPI `/libraries`
  - `app/api/libraries/[id]/route.ts` → FastAPI `/libraries/{id}`
  - `app/api/libraries/[id]/media/route.ts` → FastAPI `/libraries/{id}/media`
  - `app/api/libraries/[id]/media/[mediaId]/route.ts` → FastAPI `/libraries/{id}/media/{media_id}`
  - `app/api/media/[id]/route.ts` → FastAPI `/media/{id}`
  - `app/api/media/[id]/fragments/route.ts` → FastAPI `/media/{id}/fragments`
- Shared proxy helper:
  - extract bearer token from Supabase SSR session
  - attach `X-Nexus-Internal` header
  - forward method, headers, body
  - pass through status + body

### Frontend Changes — UI Shell
- Navbar component (collapsible)
- Tabsbar component
- Pane container (horizontal, resizable)
- Pages (connected to real API, no mock data):
  - `/libraries` → library list
  - `/libraries/[id]` → library detail (media list)
  - `/media/[id]` → media view (renders `html_sanitized`)
- Loading states and error states
- Responsive layout

### Documentation + Scripts
- `README.md`:
  - Project overview
  - Local development setup
  - Environment variables reference
- `CONTRIBUTING.md`:
  - Test commands (`pytest`, `npm test`)
  - PR checklist
  - Code style guide
- `scripts/dev-up.sh`:
  - starts postgres + redis
  - runs migrations
  - starts fastapi + nextjs
- `scripts/test.sh`:
  - runs all backend + frontend tests
- `scripts/seed_dev.py`:
  - seeds fixture data for local dev

### Tests — BFF Smoke Tests (3)

| # | Scenario | Expected |
|---|----------|----------|
| B1 | Token forwarded correctly | Request succeeds, user authenticated |
| B2 | Internal header attached | Request succeeds in staging env |
| B3 | BFF attaches header when required | Add test-only `/__test/echo_headers` endpoint (test env only) to verify header presence |

Note: "Missing header rejected" is tested in PR-02 via FastAPI directly (BFF always attaches header).

### Frontend Tests
- Navigation: libraries → library detail → media view
- Responsive layout smoke test
- Panes render and resize
- Error states displayed correctly

### Acceptance
- Browser never calls FastAPI directly
- BFF boundary enforced
- Clean API paths (no `/proxy/`)
- User can navigate libraries → media
- No highlight/chat UI present
- New developer can onboard using README
- All scripts work on clean checkout
- Tag `slice-0-complete`

---

## Merge Order (Strict)

```
PR-01  Backend Platform + DB Schema
  → PR-02  Auth Boundary + Bootstrap + Test Harness
    → PR-03  Libraries + Membership Rules + Library-Media
      → PR-04  Media/Fragments Routes + Full Slice-0 Test Suite
        → PR-05  Next.js BFF + UI Shell + Onboarding
```

---

## Exit Criteria

Slice 0 is complete when:
- All 5 PRs merged in order
- By end of PR-04: all 26 FastAPI scenarios pass (20 + 6 visibility)
- By end of PR-05: BFF smoke tests pass (3) + UI navigation works
- No skipped tests (backend or frontend)
- No TODOs for core invariants
- Main branch is releasable
