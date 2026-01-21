# s0_spec.md — slice 0: foundation (auth, libraries, visibility)

this spec defines the **minimum correct system** for auth, libraries, and visibility.
nothing beyond this slice may be implemented until all acceptance criteria pass.

---

## goal

establish a secure foundation where:
- every request has a verified identity
- every read path enforces visibility
- no cross-library or cross-user data leaks are possible

slice 0 proves the system’s core access-control model is correct.

---

## non-goals

explicitly out of scope for this slice:
- media ingestion or rendering
- highlights creation or editing
- conversations or messages creation
- search
- ui beyond minimal dev scaffolding
- rls policy authoring
- billing or plan enforcement

---

## hard constraints (from constitution)

- fastapi is the sole authorization boundary
- supabase auth is the identity provider
- clients never access postgrest directly
- visibility is enforced via a single canonical predicate
- forbidden object reads return **404**, not 403 (except admin-only membership mutations in this slice)

---

## auth model

### identity provider
- supabase auth (gotrue)

### accepted auth mechanisms
- browser: cookies set by supabase ssr integration
- non-browser clients: `Authorization: Bearer <access_token>`

fastapi extracts access tokens from cookies using a single helper. if both cookie and bearer are present, bearer takes precedence.
nextjs and fastapi are served under the same site, and cookies are configured so the api receives them (SameSite/Domain set appropriately). cookie auth is required for browser clients; bearer is allowed for non-browser clients.

### token verification (mandatory)
for every request:
- extract access token (bearer or cookie)
- verify jwt **locally via jwks**:
  - valid signature
  - `exp` not expired
  - expected `iss`
  - expected `aud` (required; missing `aud` is rejected)
  - accepted algorithms: **RS256 only**
- derive `viewer_user_id` from `sub`

jwks handling:
- fastapi fetches jwks from the configured supabase project jwks url
- jwks are cached in memory and rotation is handled without per-request introspection
- startup: the app must not serve requests until a valid jwks set is available (fail to start or return 503)
- refresh: if refresh fails, continue using the last-known-good jwks while it remains valid; do not fail all requests solely due to refresh errors; log loudly

logging guardrails:
- do not log raw tokens
- if needed, log only a token fingerprint (first 8 chars of sha256)

failure modes:
- missing or invalid token → `401 E_UNAUTHORIZED`

fastapi MUST NOT:
- accept viewer identity from headers or body
- call supabase introspection endpoints per request

---

## test-only auth bypass

fastapi provides a test-only bypass used only in integration tests:
- enabled only when `ENV=test`
- requires `X-Test-Auth: <secret>` to match a test-only env var
- accepts `X-Test-Viewer-Id: <uuid>` header
- middleware rejects this header unless `ENV=test` (return `400 E_INVALID_REQUEST`) and logs a security warning

note: the test bypass still triggers user bootstrap for the injected viewer id. slice 0 tests do **not** validate jwks verification; they validate access-control gating.

---

## user bootstrap

### invariant
for every authenticated request, a corresponding row MUST exist in `users`.

### behavior
on first authenticated request for a given `sub`:
- create `users` row with:
  - `id = sub`
  - `email` if present in token, otherwise null
  - `created_at = now()`
- create default personal library
- create owner membership row in `library_users`

bootstrap must run in a single database transaction:
- upsert user
- upsert default library
- upsert owner membership

this operation must be idempotent and race-safe:
- `INSERT ... ON CONFLICT (id) DO NOTHING` for users
- default library creation guarded by a unique constraint; on conflict, select existing

email is not a primary identity key and must not be used for authorization.

---

## libraries

### default personal library
for each user `u`:
- exactly one default library exists
- properties:
  - `owner_user_id = u`
  - `is_default = true`
  - cannot be shared
  - cannot be deleted

enforcement:
- unique constraint: one default library per user
- service-layer logic rejects attempts to share
- deny tests required for attempts to add members to a default library
- data integrity rules (service-layer):
  - owner row in `library_users` must have `role = admin`
  - owner membership cannot be deleted or downgraded
  - library must always have at least one admin

### membership
- `library_users` defines membership
- roles:
  - `admin`: may mutate library and membership
  - `member`: read-only
- membership uniqueness: `(library_id, user_id)`

slice 0 does NOT include UI for membership management.
slice 0 uses `user_id` only; email lookup for membership is slice 5.

---

## media (stub)

media exists only to support visibility testing.

minimum fields:
- `id`
- `kind`
- `processing_status`
- `created_at`

media MUST be associated with libraries via `library_media`.

---

## social object stubs (visibility only)

the following tables exist ONLY with fields required for visibility.

### highlights (stub)
required fields:
- `id`
- `owner_user_id`
- `sharing` (`private | library | public`)
- `anchor_media_id`
- `created_at`

---

## visibility model (core of slice 0)

### definitions

- **media readability**:
  a viewer may read a media item iff `media_id ∈ visible_media_ids(viewer)`.

- **public visibility**:
  `sharing = public` means any authenticated viewer may see the object.
  endpoints still require authentication in v1.
  public does not override media readability in v1.

- **anchor media**:
  - highlight → `anchor_media_id`

- **shared-library intersection**:
  there exists a library `L` such that:
  - viewer ∈ members(L)
  - owner ∈ members(L)
  - anchor_media_id ∈ media(L)

### `can_view(viewer, object)` predicate

a viewer may see a social object (highlights in s0) iff:
- `sharing = public`, OR
- `sharing = private` AND `viewer = owner`, OR
- `sharing = library` AND shared-library intersection exists

rules:
- `sharing = library` requires a non-null anchor media
- context or references never expand visibility

### `visible_media_ids(viewer)` primitive

define a canonical helper that returns all media ids visible to a viewer:
- join `library_users → library_media`
- distinct `media_id`

ALL media read paths MUST use this primitive (or an equivalent join).

---

## api surface (minimum)

### response shapes (minimum)

all responses are wrapped in the standard envelope. minimum fields:

- **library**: `id`, `name` (nullable), `is_default`, `owner_user_id`, `role_of_viewer`
- **media**: `id`, `kind`, `processing_status`
- **highlight**: `id`, `owner_user_id`, `sharing`, `anchor_media_id`, `created_at`

### read endpoints (required)

1. `GET /libraries`
   - returns libraries where viewer is a member

2. `GET /libraries/{library_id}`
   - returns library if viewer is a member
   - otherwise: `404 E_NOT_FOUND`

3. `GET /libraries/{library_id}/media`
   - returns media in the library if viewer is a member
   - otherwise: `404 E_NOT_FOUND`

4. `GET /media/{media_id}`
   - returns media stub if `media_id ∈ visible_media_ids(viewer)`
   - otherwise: `404 E_NOT_FOUND`

5. `GET /media/{media_id}/highlights`
   - if `media_id` is not visible, return `404 E_NOT_FOUND`
   - returns highlights where `highlight.anchor_media_id = media_id`
   - applies `can_view` to each highlight
   - invisible highlights are not returned
   - public does not bypass media readability in v1

these endpoints exist even though creation is not implemented.

### admin-only membership mutations (required for tests)

6. `POST /libraries/{library_id}/members`
   - body: `{ "user_id": "...", "role": "admin|member" }`
   - admin-only
   - cannot add members to default libraries → `400 E_DEFAULT_LIBRARY_CANNOT_SHARE`

7. `DELETE /libraries/{library_id}/members/{user_id}`
   - admin-only
   - owner membership cannot be removed
   - library must retain at least one admin

### error behavior
- forbidden reads of objects → `404 E_NOT_FOUND`
- admin-only membership mutations → `403 E_FORBIDDEN`

---

## error model

all errors use the envelope:
```json
{
  "error": {
    "code": "E_...",
    "message": "human readable"
  }
}
```

minimum codes used in s0:
- `E_UNAUTHORIZED` (401)
- `E_NOT_FOUND` (404)
- `E_FORBIDDEN` (403)
- `E_INVALID_REQUEST` (400)
- `E_VALIDATION_ERROR` (400)
- `E_CONFLICT` (409)
- `E_DEFAULT_LIBRARY_CANNOT_SHARE` (400)
- `E_USER_NOT_FOUND` (404)
- `E_INTERNAL` (500)

`E_INVALID_REQUEST` is for malformed path/body/query.
`E_VALIDATION_ERROR` is for semantic validation failures (e.g., invalid enum).

---

## schema constraints and indexes (required)

foreign keys:
- all `*_user_id` → `users(id)`
- `anchor_media_id` → `media(id)`

indexes:
- `library_users(user_id)`
- `library_media(library_id)`
- `library_media(media_id)`
- `highlights(owner_user_id)`
- `highlights(anchor_media_id)`

---

## testing requirements (mandatory)

### integration test environment

- dockerized postgres
- migrations applied
- fastapi runs with the **test-only auth bypass** described above

### required tests

1. **auth enforcement**
   - unauthenticated request → 401

2. **default library creation**
   - first request for new user creates user + default library
   - repeated requests do not create duplicates

3. **no cross-library leak (highlight)**
   - user A and user B
   - media M in A’s library only
   - highlight by A on M
   - B cannot see highlight → empty list

4. **shared-library visibility**
   - add B to A’s library
   - B can now see highlight

5. **shared membership is not enough**
   - A and B share a library L
   - highlight anchored to media not in L
   - B cannot see highlight

6. **private object isolation**
   - `sharing=private` object never visible to non-owner, even with shared library

7. **default library cannot be shared**
   - attempt to add member to default library → `400 E_DEFAULT_LIBRARY_CANNOT_SHARE`

8. **membership mutation authorization**
   - non-admin add member → 403
   - non-admin remove member → 403

9. **admin invariants**
   - attempt to remove the last admin → rejected
   - attempt to remove/downgrade the owner admin → rejected

ALL read paths added in this slice must be exercised by at least one allow and one deny test.

---

## completion criteria

slice 0 is complete when:
- all tests pass
- every read endpoint uses `can_view` and/or `visible_media_ids`
- no endpoint returns data based on client-supplied identity
- no new surface contradicts the constitution

no later slice may proceed until this slice is merged.
