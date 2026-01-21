# pr_roadmap.md — slice 0 (auth, libraries, visibility)

this roadmap breaks slice 0 into small, reviewable PRs. each PR is independently mergeable and has clear dependencies.

non-goal: this document is not a spec; it’s sequencing + boundaries only.

---

## pr-00 — repo + test harness skeleton

**goal**
establish the minimal project scaffold needed to run fastapi and integration tests.

**includes**
- fastapi app skeleton + config loader (env-based)
- docker-compose (or testcontainers config) for postgres in tests
- migrations framework wired (alembic or equivalent)
- pytest integration test harness that can boot the app and hit endpoints
- standard error envelope helper (`{error:{code,message}}`)

**excludes**
- any real auth verification
- any real endpoints beyond `/health` (optional)
- any schema beyond a placeholder migration

**deps**
- none

---

## pr-01 — schema v0: core tables + constraints

**goal**
create the slice-0 database schema with constraints + indexes.

**includes**
- migrations for:
  - `users`
  - `libraries`
  - `library_users`
  - `media` (stub)
  - `library_media`
  - `highlights` (stub)
- all FKs, uniques, and indexes specified in s0_spec
- enum types for:
  - `library_role` (admin/member)
  - `sharing` (private/library/public)
  - `media_kind` (stub ok)
  - `processing_status` (stub ok)

**excludes**
- any business logic
- any endpoints

**deps**
- pr-00

---

## pr-02 — db access layer: repositories + transaction pattern

**goal**
standardize DB access patterns so later PRs don’t invent their own.

**includes**
- db session dependency (per-request)
- repository functions for:
  - user upsert/get
  - default library get/create
  - membership get/create/delete + role checks
  - default library non-shareability check helper
  - visible_media_ids query
  - highlight listing by anchor_media_id (raw, no visibility yet)
- transaction helper for bootstrap (single tx)

**excludes**
- auth verification
- endpoint routing

**deps**
- pr-01

---

## pr-03 — api schemas: request/response models

**goal**
lock response/request shapes to prevent drift.

**includes**
- pydantic models for slice 0 endpoints
- error envelope model
- shared response wrappers

**excludes**
- pagination models

**deps**
- pr-02

---

## pr-04 — auth middleware: token extraction + test bypass

**goal**
every request derives `viewer_user_id` server-side.

**includes**
- auth dependency / middleware that:
  - extracts bearer or cookie token (bearer precedence)
  - in `ENV=test`, accepts `X-Test-Viewer-Id` bypass only with `X-Test-Auth` secret; rejects it otherwise
  - returns `401 E_UNAUTHORIZED` when missing/invalid
- verifier dependency is required in non-test mode; app will not start without it
- request context object containing `viewer_user_id`

**excludes**
- user bootstrap (next PR)
- any library logic
- any visibility logic

**deps**
- pr-00 (can be parallel with pr-01/pr-02 if desired)

---

## pr-05 — jwks verification: local RS256 validation

**goal**
real token verification works in non-test mode.

**includes**
- jwks fetch + caching + refresh policy per s0_spec
- RS256-only verification
- iss/aud/exp validation
- “no token logging” guardrails (fingerprint only)

**excludes**
- no calls to supabase introspection endpoints
- no user bootstrap

**deps**
- pr-04

---

## pr-06 — user bootstrap: user + default library + owner membership

**goal**
first authenticated request creates user + default library invariant.

**includes**
- idempotent, race-safe bootstrap transaction:
  - upsert user
  - create/get default library (unique per owner)
  - ensure owner admin membership exists
- constraints enforced:
  - exactly one default library per user
  - owner membership cannot be downgraded/removed (enforced in mutation PR later, but bootstrap should never violate)

**excludes**
- membership management endpoints
- can_view predicate

**deps**
- pr-02
- pr-05

---

## pr-07 — visibility core: visible_media_ids + can_view implementation

**goal**
centralize and lock the visibility rules.

**includes**
- `visible_media_ids(viewer)` canonical query helper
- `can_view_highlight(viewer, highlight)` implementation:
  - public / private / library via shared-library intersection
  - library sharing requires non-null anchor_media_id
- shared-library intersection query helper

**excludes**
- endpoints

**deps**
- pr-02
- pr-06

---

## pr-08 — read endpoints: libraries + media (gated)

**goal**
ship the required read surface with correct gating.

**includes**
- endpoints:
  - `GET /libraries`
  - `GET /libraries/{library_id}`
  - `GET /libraries/{library_id}/media`
  - `GET /media/{media_id}`
- all use viewer identity from auth dependency
- all reads gate via membership / visible_media_ids
- forbidden reads return `404 E_NOT_FOUND`

**excludes**
- highlights endpoint
- membership mutation endpoints

**deps**
- pr-07

---

## pr-09 — read endpoint: highlights (gated + can_view)

**goal**
`GET /media/{media_id}/highlights` is correct and leak-free.

**includes**
- endpoint:
  - `GET /media/{media_id}/highlights`
- first gate: `media_id ∈ visible_media_ids(viewer)` else 404
- then filter highlights by `can_view_highlight`
- return only visible highlights

**excludes**
- highlight creation/edit/delete

**deps**
- pr-07
- pr-08

---

## pr-10 — membership mutations (admin-only) + default library guardrails

**goal**
enable membership changes needed for visibility tests.

**includes**
- endpoints:
  - `POST /libraries/{library_id}/members`
  - `DELETE /libraries/{library_id}/members/{user_id}`
- admin-only authorization:
  - non-admin → `403 E_FORBIDDEN`
- rules:
  - cannot add members to default library → `400 E_DEFAULT_LIBRARY_CANNOT_SHARE`
  - cannot remove owner membership
  - must retain at least one admin
  - if `user_id` not found → `404 E_USER_NOT_FOUND`

**excludes**
- add-by-email (slice 5)
- invitations

**deps**
- pr-07
- pr-08

---

## pr-11 — test fixtures/factories

**goal**
make integration tests readable and repeatable.

**includes**
- helpers to create users, libraries, memberships, media, library_media
- helpers to create highlights with sharing modes
- fixtures for common test graphs

**excludes**
- api-level tests (in pr-12)

**deps**
- pr-02

---

## pr-12 — integration tests: no-leak suite for slice 0

**goal**
prove the access model with the required integration tests.

**includes**
- all required tests from s0_spec:
  - auth enforcement
  - default library creation idempotence
  - no cross-library leak
  - shared-library visibility
  - shared membership not enough
  - private isolation
  - default library cannot be shared
  - membership mutation auth
  - admin invariants
- tests use test-only auth bypass header
- at least one allow + deny test per read path added in slice 0

**excludes**
- performance tests
- load tests

**deps**
- pr-09
- pr-10
- pr-11

---

## dependency graph (summary)

pr-00
  ├─ pr-01 ─ pr-02 ─ pr-03 ─ pr-06 ─ pr-07 ─ pr-08 ─ pr-09 ─┐
  └─ pr-04 ─ pr-05 ────────────────────────────────┘         │
                                                             ├─ pr-10 ─┐
                                                             ├─ pr-11 ┤
                                                             └─ pr-12 ─┘
