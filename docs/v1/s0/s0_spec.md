# Nexus — Slice 0 Spec (L2)

## Auth + Libraries Core

This document defines the complete, binding specification for Slice 0. It must conform to `constitution.md` (v1) and the approved L1 roadmap.

---

## 0. Goals and Non-Goals

### Goals

Slice 0 establishes:
- Identity and authentication
- Authorization and visibility enforcement
- Library + membership core
- Default library invariants
- Minimal UI shell for navigation
- A stable foundation for all later slices

### Non-Goals

Slice 0 explicitly does **not** include:
- Library sharing / invitations
- Real media ingestion pipeline
- Highlights, annotations, conversations
- Search
- Jobs, storage, or processing logic
- Any non-browser client support

---

## 1. Scope Summary (What Ships)

A logged-in user can:
- Authenticate via browser
- See their default library (auto-created on first login)
- Create and delete non-default libraries
- Add and remove seeded fixture media to/from libraries (no user-created media in S0)
- See library contents in a pane-based UI

The system:
- Enforces visibility strictly server-side
- Enforces default library closure invariants
- Rejects all unauthorized access with correct semantics
- Passes full integration test coverage for visibility and invariants

---

## 2. Data Model (Authoritative)

### 2.1 Users

```sql
users (
  id uuid primary key,              -- equals supabase auth `sub`
  created_at timestamptz not null default now()
)
```

**Invariants:**
- `users.id` MUST equal the Supabase auth user id (`sub`)
- A user row is created lazily on first authenticated request (see §3.4)
- Duplicates are forbidden

---

### 2.2 Libraries

```sql
libraries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references users(id),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

-- Enforce exactly one default library per user
create unique index libraries_one_default_per_user
  on libraries (owner_user_id)
  where is_default = true;
```

**Invariants:**
- Each user has exactly one `is_default = true` library (enforced by partial unique index)
- Default library:
  - Name: `"My Library"` (not user-editable in v1)
  - Cannot be deleted
  - Cannot be shared (future slices)
  - Cannot be renamed
- `owner_user_id` must be an admin member (enforced at creation, see §2.3)

**`updated_at` handling:**
- Updated by app code on any mutation (no db trigger in v1)

---

### 2.3 Memberships

```sql
memberships (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  unique (library_id, user_id)
)
```

**Invariants:**
- Every library has ≥1 admin
- The last admin cannot be removed or demoted
- Only admins may mutate library state
- Owner membership rules:
  - When creating a library, owner membership row (`role=admin`) is created in the same transaction
  - Owner membership row can never be removed (enforced in service layer)
  - Owner membership role can never be demoted to `member`

---

### 2.4 Media (Seeded Fixture Only)

In Slice 0, we use a **real `web_article`** seeded via test fixtures (no fake "placeholder" kind).

```sql
media (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('web_article', 'epub', 'pdf', 'podcast_episode', 'video')),
  title text not null,
  canonical_source_url text,
  processing_status text not null check (processing_status in (
    'pending', 'extracting', 'ready_for_reading', 'embedding', 'ready', 'failed'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

**S0 constraints:**
- No endpoint creates media in S0; media exists only via test fixtures
- Fixture media uses `kind = 'web_article'`, `processing_status = 'ready_for_reading'`
- Other `processing_status` values are defined for schema completeness but unused in S0

---

### 2.5 Fragments (Seeded Fixture Only)

```sql
fragments (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references media(id) on delete cascade,
  idx integer not null,
  html_sanitized text not null,
  canonical_text text not null,
  created_at timestamptz not null default now(),
  unique (media_id, idx)
)
```

**Seeded fixture:**
- One fragment row for the seeded web_article
- `idx = 0`
- Contains sanitized HTML and canonical text from fixture

---

### 2.6 Library Media

```sql
library_media (
  library_id uuid not null references libraries(id) on delete cascade,
  media_id uuid not null references media(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (library_id, media_id)
)
```

**Cascade behavior:**
- Deleting a library cascades to delete all `library_media` rows for that library
- Deleting media cascades to delete all `library_media` rows for that media

---

## 3. Authentication and Request Model

### 3.1 Browser → Next.js

- Browser authenticates via Supabase
- Session is managed via `@supabase/ssr`
- Browser never calls FastAPI directly

### 3.2 Next.js → FastAPI (BFF)

Every request forwarded to FastAPI must include:
- `Authorization: Bearer <supabase_access_token>`
- `X-Nexus-Internal: <shared_secret>` (always attached by Next.js)

Next.js performs no domain logic.

### 3.2.1 Environment Configuration

**`NEXUS_ENV`** determines security enforcement:

| Value | Internal Header | Description |
|-------|-----------------|-------------|
| `local` | Optional | Local development |
| `test` | Optional | Automated tests |
| `staging` | **Required** | Pre-production |
| `prod` | **Required** | Production |

**Rules:**
- Next.js **always** attaches `X-Nexus-Internal` header (regardless of env)
- FastAPI **only enforces** the header check when `NEXUS_ENV ∈ {staging, prod}`
- If `NEXUS_ENV` is unset, default to `local` (optional)
- Shared secret is read from `NEXUS_INTERNAL_SECRET` env var

---

### 3.3 FastAPI Auth Middleware (Hard Requirements)

On every request:
1. Verify bearer token:
   - Signature via Supabase JWKS
   - `exp`, `iss`, `aud`
2. Derive `viewer_user_id = sub`
3. Verify internal secret header (if `NEXUS_ENV ∈ {staging, prod}`):
   - Missing or mismatched → **403 `E_INTERNAL_ONLY`** (not 401)
   - Skipped when `NEXUS_ENV ∈ {local, test}`
4. Call `ensure_user_and_default_library(viewer_user_id)` (see §3.4)

FastAPI **never**:
- Reads cookies
- Accepts user ID from request body or headers
- Accepts refresh tokens

---

### 3.4 User and Default Library Creation (Race-Safe)

On every authenticated request, call `ensure_user_and_default_library(user_id)`.

**Implementation (handles races correctly):**

```python
def ensure_user_and_default_library(user_id: UUID) -> UUID:
    """
    Ensures user exists, default library exists, and owner membership exists.
    Returns the default library ID.

    Race-safe: uses SELECT after INSERT attempts, catches unique violations.
    Always ends with valid state regardless of concurrent requests.
    """
    with db.transaction():
        # Step 1: Ensure user exists
        db.execute("""
            INSERT INTO users (id)
            VALUES (:user_id)
            ON CONFLICT (id) DO NOTHING
        """, user_id=user_id)

        # Step 2: Check if default library already exists
        default_library_id = db.scalar("""
            SELECT id FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
        """, user_id=user_id)

        # Step 3: If no default library, create one (catch race)
        if default_library_id is None:
            try:
                default_library_id = db.scalar("""
                    INSERT INTO libraries (name, owner_user_id, is_default)
                    VALUES ('My Library', :user_id, true)
                    RETURNING id
                """, user_id=user_id)
            except UniqueViolationError:
                # Lost race: another request created it; fetch the existing one
                default_library_id = db.scalar("""
                    SELECT id FROM libraries
                    WHERE owner_user_id = :user_id AND is_default = true
                """, user_id=user_id)

        # Step 4: Ensure owner membership exists (idempotent)
        # Handles edge case: library exists but membership doesn't (partial failure recovery)
        db.execute("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
            ON CONFLICT (library_id, user_id) DO NOTHING
        """, library_id=default_library_id, user_id=user_id)

        return default_library_id
```

**Guarantees:**
- First request wins library creation; concurrent requests safely read existing
- Partial unique index on `(owner_user_id) WHERE is_default = true` prevents duplicate defaults
- Membership always exists after call completes (recovers from partial failures)
- Returns default library ID for use in `/me` and other endpoints

---

## 4. Authorization and Visibility Rules

### 4.1 Canonical Predicates

```python
def can_read_media(viewer_id: UUID, media_id: UUID) -> bool:
    """Viewer can read media iff it's in a library they're a member of."""
    return db.exists("""
        SELECT 1 FROM library_media lm
        JOIN memberships m ON m.library_id = lm.library_id
        WHERE lm.media_id = :media_id
        AND m.user_id = :viewer_id
    """, media_id=media_id, viewer_id=viewer_id)

def default_library_id(user_id: UUID) -> UUID:
    """Returns the default library ID for a user."""
    return db.scalar("""
        SELECT id FROM libraries
        WHERE owner_user_id = :user_id AND is_default = true
    """, user_id=user_id)
```

### 4.2 Library Access

- **Listing libraries:** Only libraries where viewer is a member
- **Fetching library by ID:**
  - If viewer is not a member → **404 `E_LIBRARY_NOT_FOUND`**
- **Mutating library:**
  - Viewer must be admin → **403 `E_FORBIDDEN`** otherwise

### 4.3 Media Visibility Masking

- If `media_id` does not exist → **404 `E_MEDIA_NOT_FOUND`**
- If `media_id` exists but viewer cannot read it → **404 `E_MEDIA_NOT_FOUND`** (mask existence)
- All media operations require `can_read_media(viewer_id, media_id)` check

### 4.4 Content Safety Guardrail

**Hard rule:** No endpoint may ever return unsanitized HTML. Only `html_sanitized` is stored and served. The `fragments` table has no `html_raw` column; sanitization happens at ingestion time and the original is discarded.

---

## 5. Default Library Closure (Critical Invariant)

### Prerequisite Invariant

The closure logic assumes **every library member has a default library**. This is guaranteed in S0 because:
- S0 has no sharing; the only member is the viewer
- Viewer's default library is created via `ensure_user_and_default_library` in auth middleware

**S1 constraint:** When library sharing is added, `ensure_user_and_default_library(invited_user_id)` MUST be called at invite-accept time. Otherwise the insert-select for default library closure will silently skip users without default libraries, violating the invariant.

### 5.1 Add Media to Library

**Service-layer transaction:**

```python
def add_media_to_library(viewer_id: UUID, library_id: UUID, media_id: UUID) -> dict:
    """
    Add media to library. Enforces default library closure for all members.
    Returns the created library_media association.
    """
    with db.transaction():
        # Step 1: Verify library exists and viewer is admin
        membership = db.one_or_none("""
            SELECT m.role, l.is_default
            FROM memberships m
            JOIN libraries l ON l.id = m.library_id
            WHERE m.library_id = :library_id AND m.user_id = :viewer_id
            FOR UPDATE OF l
        """, library_id=library_id, viewer_id=viewer_id)

        if membership is None:
            raise NotFoundError("E_LIBRARY_NOT_FOUND")
        if membership.role != 'admin':
            raise ForbiddenError("E_FORBIDDEN")

        # Step 2: Verify media exists (no visibility check needed for "exists")
        media_exists = db.exists("""
            SELECT 1 FROM media WHERE id = :media_id
        """, media_id=media_id)

        if not media_exists:
            raise NotFoundError("E_MEDIA_NOT_FOUND")

        # Step 3: Insert into target library
        result = db.one_or_none("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:library_id, :media_id)
            ON CONFLICT (library_id, media_id) DO NOTHING
            RETURNING library_id, media_id, created_at
        """, library_id=library_id, media_id=media_id)

        # Step 4: Enforce default library closure for all members of this library
        db.execute("""
            INSERT INTO library_media (library_id, media_id)
            SELECT default_lib.id, :media_id
            FROM memberships m
            JOIN libraries default_lib
                ON default_lib.owner_user_id = m.user_id
                AND default_lib.is_default = true
            WHERE m.library_id = :library_id
            ON CONFLICT (library_id, media_id) DO NOTHING
        """, library_id=library_id, media_id=media_id)

        # Return result (may be None if already existed)
        if result is None:
            result = db.one("""
                SELECT library_id, media_id, created_at
                FROM library_media
                WHERE library_id = :library_id AND media_id = :media_id
            """, library_id=library_id, media_id=media_id)

        return result
```

### 5.2 Remove Media from Library

**S0 scope:** In S0 there is no membership mutation except owner membership creation. All non-default libraries are single-member and owned by the viewer. The single-member logic below is only relevant to user-owned libraries. Membership-count transitions (multi-member → single-member) are not handled in S0; that's S1+.

**Service-layer transaction:**

```python
def remove_media_from_library(viewer_id: UUID, library_id: UUID, media_id: UUID) -> None:
    """
    Remove media from library. Enforces default library closure rules.

    If removing from default library:
      - Also remove from all single-member libraries owned by viewer
    If removing from non-default library:
      - Does not affect default library
    """
    with db.transaction():
        # Step 1: Fetch library with lock
        library = db.one_or_none("""
            SELECT l.id, l.is_default, l.owner_user_id
            FROM libraries l
            WHERE l.id = :library_id
            FOR UPDATE
        """, library_id=library_id)

        if library is None:
            raise NotFoundError("E_LIBRARY_NOT_FOUND")

        # Step 2: Verify viewer is admin member
        membership = db.one_or_none("""
            SELECT role FROM memberships
            WHERE library_id = :library_id AND user_id = :viewer_id
        """, library_id=library_id, viewer_id=viewer_id)

        if membership is None:
            raise NotFoundError("E_LIBRARY_NOT_FOUND")  # mask membership check as 404
        if membership.role != 'admin':
            raise ForbiddenError("E_FORBIDDEN")

        # Step 3: Verify media exists in this library (mask if not readable)
        in_library = db.exists("""
            SELECT 1 FROM library_media
            WHERE library_id = :library_id AND media_id = :media_id
        """, library_id=library_id, media_id=media_id)

        if not in_library:
            # Check if media exists at all (for correct error)
            media_exists = db.exists("SELECT 1 FROM media WHERE id = :media_id", media_id=media_id)
            if not media_exists:
                raise NotFoundError("E_MEDIA_NOT_FOUND")
            # Media exists but not in this library - still 404 (mask)
            raise NotFoundError("E_MEDIA_NOT_FOUND")

        # Step 4: Get viewer's default library ID for closure logic
        viewer_default_library_id = db.scalar("""
            SELECT id FROM libraries
            WHERE owner_user_id = :viewer_id AND is_default = true
        """, viewer_id=viewer_id)

        if library.is_default:
            # Removing from default library: cascade to single-member libraries owned by viewer

            # Find all libraries where:
            #   - viewer is the ONLY member (membership count = 1)
            #   - viewer owns the library (owner_user_id = viewer_id)
            #   - library is NOT the default library (already handling separately)
            db.execute("""
                DELETE FROM library_media
                WHERE media_id = :media_id
                AND library_id IN (
                    SELECT l.id
                    FROM libraries l
                    JOIN memberships m ON m.library_id = l.id
                    WHERE l.owner_user_id = :viewer_id
                    AND l.is_default = false
                    GROUP BY l.id
                    HAVING COUNT(m.id) = 1
                )
            """, media_id=media_id, viewer_id=viewer_id)

            # Now remove from default library
            db.execute("""
                DELETE FROM library_media
                WHERE library_id = :library_id AND media_id = :media_id
            """, library_id=library_id, media_id=media_id)
        else:
            # Removing from non-default library: does NOT affect default library
            db.execute("""
                DELETE FROM library_media
                WHERE library_id = :library_id AND media_id = :media_id
            """, library_id=library_id, media_id=media_id)
```

---

## 6. API Surface (Slice 0 Only)

> **Authentication:** All endpoints require valid auth.
> **Response envelope:** `{ "data": ... }` on success, `{ "error": { "code": "...", "message": "..." } }` on failure.

---

### `GET /me`

Returns current user info.

**Response:**
```json
{
  "data": {
    "user_id": "uuid",
    "default_library_id": "uuid"
  }
}
```

**Errors:** `E_UNAUTHENTICATED`

---

### `GET /libraries`

Returns all libraries the viewer is a member of.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "owner_user_id": "uuid",
      "is_default": true,
      "role": "admin",
      "created_at": "iso8601",
      "updated_at": "iso8601"
    }
  ]
}
```

**Ordering:** `created_at asc, id asc`

**Limits:** Default 100, max 200. Returns first N libraries only. Cursor pagination deferred to S1+.

**Errors:** `E_UNAUTHENTICATED`

---

### `POST /libraries`

Creates a non-default library. Viewer becomes owner and admin.

**Request:**
```json
{ "name": "string (required, 1-100 chars)" }
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "string",
    "owner_user_id": "uuid",
    "is_default": false,
    "role": "admin",
    "created_at": "iso8601",
    "updated_at": "iso8601"
  }
}
```

**Errors:** `E_UNAUTHENTICATED`, `E_INVALID_REQUEST`, `E_NAME_INVALID`

---

### `PATCH /libraries/{library_id}`

Rename library. Admin only. Cannot rename default library.

**Request:**
```json
{ "name": "string (required, 1-100 chars)" }
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "string",
    "owner_user_id": "uuid",
    "is_default": false,
    "role": "admin",
    "created_at": "iso8601",
    "updated_at": "iso8601"
  }
}
```

**Errors:** `E_UNAUTHENTICATED`, `E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`, `E_DEFAULT_LIBRARY_FORBIDDEN`, `E_INVALID_REQUEST`, `E_NAME_INVALID`

---

### `DELETE /libraries/{library_id}`

Delete library. **Any admin** can delete (not owner-only).

**Constraints:**
- Forbidden if `is_default = true` → `E_DEFAULT_LIBRARY_FORBIDDEN`
- Viewer must be admin → `E_FORBIDDEN` otherwise

**Behavior:**
- Deletes the library row
- `ON DELETE CASCADE` removes all `library_media` and `memberships` rows
- This is intentional: in S0 there is no sharing, so cascade is safe
- In S1+, shared libraries will have additional protections (`E_LIBRARY_DELETE_FORBIDDEN_SHARED`)

**Implementation:**
```python
def delete_library(viewer_id: UUID, library_id: UUID) -> None:
    with db.transaction():
        # Fetch library with membership check
        result = db.one_or_none("""
            SELECT l.id, l.is_default, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
            FOR UPDATE OF l
        """, library_id=library_id, viewer_id=viewer_id)

        if result is None:
            raise NotFoundError("E_LIBRARY_NOT_FOUND")
        if result.is_default:
            raise ForbiddenError("E_DEFAULT_LIBRARY_FORBIDDEN")
        if result.role != 'admin':
            raise ForbiddenError("E_FORBIDDEN")

        # CASCADE handles library_media and memberships cleanup
        db.execute("DELETE FROM libraries WHERE id = :library_id", library_id=library_id)
```

**Response:** `204 No Content`

**Errors:** `E_UNAUTHENTICATED`, `E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`, `E_DEFAULT_LIBRARY_FORBIDDEN`

---

### `GET /libraries/{library_id}/media`

Lists media in library.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "kind": "web_article",
      "title": "string",
      "canonical_source_url": "string | null",
      "processing_status": "ready_for_reading",
      "created_at": "iso8601",
      "updated_at": "iso8601"
    }
  ]
}
```

**Ordering:** `library_media.created_at desc, media.id desc` (stable ordering guaranteed)

**Limits:** Default 100, max 200. Returns first N media only. Cursor pagination deferred to S1+.

**Errors:** `E_UNAUTHENTICATED`, `E_LIBRARY_NOT_FOUND`

---

### `POST /libraries/{library_id}/media`

Add media to library. Admin only. Enforces default library closure.

**Request:**
```json
{ "media_id": "uuid (required)" }
```

**Security note:** This endpoint accepts raw `media_id` without visibility check. Any existing media can be added to any library the viewer admins. This is intentional per constitution (media readable iff in your library).

**UI constraint:** In S0 this endpoint exists for internal/test use. In later slices, the UI never exposes raw `media_id` entry; users attach media via URL ingestion or file upload, not by ID. The raw-ID endpoint remains for internal operations only.

**Response:**
```json
{
  "data": {
    "library_id": "uuid",
    "media_id": "uuid",
    "created_at": "iso8601"
  }
}
```

**Errors:** `E_UNAUTHENTICATED`, `E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`, `E_MEDIA_NOT_FOUND`, `E_INVALID_REQUEST`

---

### `DELETE /libraries/{library_id}/media/{media_id}`

Remove media from library. Admin only. Enforces default library closure rules.

**Response:** `204 No Content`

**Errors:** `E_UNAUTHENTICATED`, `E_LIBRARY_NOT_FOUND`, `E_FORBIDDEN`, `E_MEDIA_NOT_FOUND`

---

### `GET /media/{media_id}`

Returns media metadata. Enforces visibility.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "kind": "web_article",
    "title": "string",
    "canonical_source_url": "string | null",
    "processing_status": "ready_for_reading",
    "created_at": "iso8601",
    "updated_at": "iso8601"
  }
}
```

**Visibility:** Returns 404 if viewer cannot read media (masks existence).

**Errors:** `E_UNAUTHENTICATED`, `E_MEDIA_NOT_FOUND`

---

### `GET /media/{media_id}/fragments`

Returns fragments for media. Enforces visibility.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "media_id": "uuid",
      "idx": 0,
      "html_sanitized": "<p>Content...</p>",
      "canonical_text": "Content...",
      "created_at": "iso8601"
    }
  ]
}
```

**Ordering:** `idx asc`

**Visibility:** Returns 404 if viewer cannot read media (masks existence).

**Errors:** `E_UNAUTHENTICATED`, `E_MEDIA_NOT_FOUND`

---

## 7. Error Semantics

### Response Envelope

```json
{ "error": { "code": "E_...", "message": "Human-readable message" } }
```

### Required Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `E_UNAUTHENTICATED` | 401 | Missing or invalid bearer token |
| `E_INTERNAL_ONLY` | 403 | Missing or invalid internal secret header (prod) |
| `E_FORBIDDEN` | 403 | Authenticated but not authorized for action |
| `E_LIBRARY_NOT_FOUND` | 404 | Library does not exist or viewer not a member |
| `E_MEDIA_NOT_FOUND` | 404 | Media does not exist or viewer cannot read it |
| `E_DEFAULT_LIBRARY_FORBIDDEN` | 403 | Cannot delete/rename default library |
| `E_LAST_ADMIN_FORBIDDEN` | 403 | Cannot remove/demote last admin |
| `E_INVALID_REQUEST` | 400 | Malformed request body (parse error, missing required field) |
| `E_NAME_INVALID` | 400 | Name empty, too long (>100 chars), or invalid |

### Status Code Semantics

- **401:** Auth problem (token missing/invalid/expired)
- **403:** Auth valid but action forbidden (not authorized, policy violation)
- **404:** Resource not found OR existence masked for unauthorized viewer

---

## 8. UI Requirements (Minimal)

Slice 0 UI must include:
- Collapsible left navbar
- Tabsbar
- Horizontal resizable panes
- Panes:
  - Library list
  - Library detail (media list)
  - Media view (renders `html_sanitized` from `GET /media/{id}/fragments`)

**Not included:** Highlighting, linked-items alignment, chat, media creation/ingestion UI.

---

## 9. Test Fixtures

### Purpose

Validate auth, visibility, and UI routing against real data model.

### Creation Mechanism

Fixtures are created in **test setup code** (pytest fixtures), NOT in database migrations.

```python
# tests/fixtures.py

import pytest
from uuid import UUID

FIXTURE_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")
FIXTURE_FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")

@pytest.fixture
def seeded_media(db):
    """Create a real web_article with fragment for testing."""
    db.execute("""
        INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
        VALUES (
            :media_id,
            'web_article',
            'Seeded Test Article',
            'https://example.com/test-article',
            'ready_for_reading'
        )
        ON CONFLICT (id) DO NOTHING
    """, media_id=FIXTURE_MEDIA_ID)

    db.execute("""
        INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
        VALUES (
            :fragment_id,
            :media_id,
            0,
            '<p>This is a seeded test article for Slice 0 validation.</p>',
            'This is a seeded test article for Slice 0 validation.'
        )
        ON CONFLICT (id) DO NOTHING
    """, fragment_id=FIXTURE_FRAGMENT_ID, media_id=FIXTURE_MEDIA_ID)

    return FIXTURE_MEDIA_ID
```

### Dev Environment Seeding

For local development, provide a separate script (not a migration):

```bash
# scripts/seed_dev.py - run manually: python scripts/seed_dev.py
```

### Fixture Invariants

- Fixture media is **not** auto-added to any library
- Tests must explicitly add fixture media to libraries via API
- Production environments have no fixture data
- Schema migrations contain no seed data

---

## 10. Integration Test Requirements

### Test Architecture

**Two-tier testing:**

1. **FastAPI Integration Tests (Primary)**
   - Tests hit FastAPI directly
   - Use test JWKS / issuer
   - Fast, comprehensive coverage
   - All business logic scenarios

2. **BFF Smoke Tests (Required)**
   - Tests go through Next.js route handlers
   - Verify the actual security boundary
   - Minimum 3 scenarios (see below)

### FastAPI Test Harness

- Tests hit FastAPI directly
- Use test JWKS / issuer
- Seed fixture data via pytest fixtures

### Required FastAPI Scenarios

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

### Required Visibility Closure Scenarios (Multi-User)

| # | Scenario | Expected |
|---|----------|----------|
| V1 | User A adds media M to library LA | A can read M |
| V2 | User B (separate user, no membership in LA) tries to read M | 404 `E_MEDIA_NOT_FOUND` |
| V3 | User A creates new library LB, does NOT add M | A can still read M (default library contains it via closure) |
| V4 | User A removes M from default library | M removed from all A's single-member libraries |
| V5 | After V4, User A tries to read M | 404 `E_MEDIA_NOT_FOUND` |
| V6 | User B adds same media M to their library | B can read M; A still cannot (separate library graphs) |

### Required BFF Smoke Tests

| # | Scenario | Expected |
|---|----------|----------|
| B1 | Next.js attaches internal header | Request reaches FastAPI |
| B2 | Next.js forwards bearer token | FastAPI authenticates correctly |
| B3 | Missing internal header rejected (NEXUS_ENV=staging) | 403 `E_INTERNAL_ONLY` |

All tests must pass before moving to Slice 1.

---

## 11. Exit Criteria

Slice 0 is complete when:
- All endpoints implemented with full request/response contracts
- All invariants enforced in service layer with transactional safety
- FastAPI integration test suite passes (20 scenarios)
- Visibility closure test suite passes (6 multi-user scenarios)
- BFF smoke test suite passes (3 scenarios)
- No visibility leaks
- Race conditions prevented by unique constraints and proper SELECT-then-INSERT patterns
- Fixtures validate real data model (no placeholder abstractions)
