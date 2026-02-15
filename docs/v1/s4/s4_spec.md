# slice 4 spec - library sharing and membership governance (l2)

this slice enables multi-user library sharing with strict, testable authorization semantics.
it upgrades s0-s3 behavior so shared access works immediately, revocation is strict for new requests, and ownership boundaries are explicit.

this is an l2 feature contract. it defines schemas, state machines, api contracts, error codes, invariants, and acceptance scenarios that multiple prs must agree on.

---

## 1) goal and scope

### goal

enable users to collaborate through shared libraries without weakening visibility, deletion, or ownership guarantees.

### in scope

- user-id invitations for existing users
- accept, decline, revoke invite lifecycle
- member and role management in non-default libraries
- owner-only container deletion and ownership transfer
- shared conversation read visibility (owner-only write remains)
- shared highlight read visibility (author-only write remains)
- strict revocation for all new requests after commit
- default-library closure materialization with provenance tracking
- explicit default-library prohibitions:
  - cannot invite to default libraries
  - cannot share conversations to default libraries

### out of scope

- email invites
- invite links or anonymous invite tokens
- public libraries
- moderation tooling beyond role/membership management
- force-cancelling in-flight requests
- semantic search or vector retrieval changes

---

## 2) frozen product decisions (mvp)

1. invites are user-id only and invitee must already exist in `users`.
2. library admins can manage members and media but cannot delete library containers.
3. only the current owner can delete a non-default library.
4. owner must transfer ownership before owner exit paths (self-removal/self-demotion) are allowed.
5. ownership transfer is one-step, owner-initiated, no acceptance handshake.
6. invite acceptance creates membership immediately in the same transaction.
7. read visibility is authoritative via membership joins immediately after commit.
8. default-library backfill is materialization/invariant repair, never read auth gating.
9. strict revocation means all new requests after commit observe revocation; in-flight requests may complete.
10. highlight list default remains mine-only for compatibility; shared highlight read is opt-in query mode.
11. conversation list ordering is deterministic global order: `updated_at DESC, id DESC`.
12. ownership transfer changes owner pointer only; previous owner remains admin by default.
13. response shape evolution is additive-only in s4 (no removal/rename of existing fields).
14. backfill retries are bounded and explicit: delays `1m, 5m, 15m, 1h, 6h`, then terminal `failed`.
15. masking policy is strict: not-visible resource -> masked `404`; visible-but-not-allowed -> `403`; bad transition/state -> `409`.
16. conversation list default remains `mine` for backward compatibility; shared visibility is opt-in via `scope`.
17. search `scope=library:*` includes message results for conversations shared to that library (not empty set).
18. `GET /search` response shape is preserved for backward compatibility in s4 (`results` + `page`), not envelope-migrated in this slice.
19. backfill requeue is supported via internal operator path in s4; manual database edits are not the primary recovery path.
20. stale duplicate visibility helpers are not allowed at slice completion; canonical predicates are the only merged read-auth path.
21. search scope masking preserves existing typed 404 behavior: unauthorized `media:*|library:*` -> `E_NOT_FOUND`; unauthorized `conversation:*` -> `E_CONVERSATION_NOT_FOUND`.

---

## 3) domain models and schema contracts

### 3.1 new table: `library_invitations`

```sql
CREATE TABLE library_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ NULL,

  CONSTRAINT ck_library_invitations_role
    CHECK (role IN ('admin', 'member')),
  CONSTRAINT ck_library_invitations_status
    CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  CONSTRAINT ck_library_invitations_not_self
    CHECK (inviter_user_id <> invitee_user_id),
  CONSTRAINT ck_library_invitations_responded_at
    CHECK (
      (status = 'pending' AND responded_at IS NULL)
      OR
      (status <> 'pending' AND responded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uix_library_invitations_pending_once
  ON library_invitations (library_id, invitee_user_id)
  WHERE status = 'pending';

CREATE INDEX idx_library_invitations_library_status_created
  ON library_invitations (library_id, status, created_at DESC, id DESC);

CREATE INDEX idx_library_invitations_invitee_status_created
  ON library_invitations (invitee_user_id, status, created_at DESC, id DESC);
```

### 3.2 new table: `default_library_intrinsics`

tracks media intentionally present in a user's default library independent of closure edges.

```sql
CREATE TABLE default_library_intrinsics (
  default_library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (default_library_id, media_id)
);

CREATE INDEX idx_default_library_intrinsics_media
  ON default_library_intrinsics (media_id, default_library_id);
```

service invariant (enforced in code): `default_library_id` must reference `libraries.is_default = true`.

### 3.3 new table: `default_library_closure_edges`

tracks which shared libraries justify default-library materialization.

```sql
CREATE TABLE default_library_closure_edges (
  default_library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  source_library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (default_library_id, media_id, source_library_id)
);

CREATE INDEX idx_default_library_closure_edges_source
  ON default_library_closure_edges (source_library_id, default_library_id, media_id);

CREATE INDEX idx_default_library_closure_edges_default_media
  ON default_library_closure_edges (default_library_id, media_id);
```

service invariants:
- `default_library_id` must be default library.
- `source_library_id` must be non-default.

### 3.4 new table: `default_library_backfill_jobs`

durable backfill intent so enqueue failure cannot silently drop closure materialization.

```sql
CREATE TABLE default_library_backfill_jobs (
  default_library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  PRIMARY KEY (default_library_id, source_library_id, user_id),

  CONSTRAINT ck_default_library_backfill_jobs_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT ck_default_library_backfill_jobs_attempts
    CHECK (attempts >= 0)
);

CREATE INDEX idx_default_library_backfill_jobs_status_updated
  ON default_library_backfill_jobs (status, updated_at ASC);
```

### 3.5 existing schema deltas (no new columns)

- `libraries.owner_user_id` remains authoritative owner pointer.
- `memberships.role` remains `'admin' | 'member'`.
- `conversation_shares` stays `(conversation_id, library_id)` pk.
- s4 adds supporting indexes on existing tables (no new columns):
  - `CREATE INDEX idx_memberships_user_library_role ON memberships (user_id, library_id, role);`
  - `CREATE INDEX idx_library_media_media_library ON library_media (media_id, library_id);`
  - `CREATE INDEX idx_conversation_shares_library_conversation ON conversation_shares (library_id, conversation_id);`

### 3.6 response schema deltas

#### `ConversationOut` (all serialized conversation outputs)

applies to:
- read endpoints (`GET /conversations*`)
- any response embedding conversation objects (including send-message response payloads)

add:
- `owner_user_id: UUID`
- `is_owner: bool` (viewer-local convenience)

retain:
- `id`, `sharing`, `message_count`, `created_at`, `updated_at`

compatibility requirement:
- additions are additive only; existing clients reading old fields continue to work unchanged.

#### `HighlightOut` (highlight read endpoints)

add:
- `author_user_id: UUID`
- `is_owner: bool`

retain existing highlight fields and optional annotation.

compatibility requirement:
- additions are additive only; existing highlight fields are unchanged.

#### new `LibraryMemberOut`

```json
{
  "user_id": "uuid",
  "role": "admin",
  "is_owner": true,
  "created_at": "timestamp"
}
```

#### new `LibraryInvitationOut`

```json
{
  "id": "uuid",
  "library_id": "uuid",
  "inviter_user_id": "uuid",
  "invitee_user_id": "uuid",
  "role": "member",
  "status": "pending",
  "created_at": "timestamp",
  "responded_at": null
}
```

### 3.7 migration seeding contract for provenance tables

s4 migration must seed provenance tables for existing data using deterministic, safety-first rules.

step 1: derive closure edges from current non-default membership + media
- for each non-default library `L`
- for each member user `u` in `L`
- for each media `m` in `L`
- insert edge `(d(u), m, L)` into `default_library_closure_edges`.

step 2: seed intrinsics for unmatched default-library rows
- for each existing default library-media row `(d, m)` in `library_media`
- if no edge exists for `(d, m)` after step 1
- insert `(d, m)` into `default_library_intrinsics`.

step 3: seed durable backfill jobs
- no bulk enqueue required at migration time.
- jobs are created lazily by accept/requeue flows in s4 runtime.

legacy ambiguity policy:
- when origin intent cannot be inferred exactly, preserve access by classifying as intrinsic.

---

## 4) state machines

### 4.1 invitation state machine

states: `pending`, `accepted`, `declined`, `revoked`.

legal transitions:
- create -> `pending`
- `pending` -> `accepted` (invitee accept)
- `pending` -> `declined` (invitee decline)
- `pending` -> `revoked` (library admin/owner revoke)

terminal states:
- `accepted`, `declined`, `revoked`

idempotent repeats:
- accept on already `accepted` by same invitee returns `200` no-op.
- decline on already `declined` by same invitee returns `200` no-op.
- revoke on already `revoked` returns `204` no-op.

illegal transitions:
- `accepted|declined|revoked` -> other terminal states.
- return `409 E_INVITE_NOT_PENDING`.

### 4.2 membership and owner lifecycle

membership states per `(library_id, user_id)`:
- absent
- present with role `member`
- present with role `admin`

legal transitions:
- absent -> present (`member` or `admin`)
- `member` <-> `admin`
- present -> absent

ownership constraints:
- owner must always have membership with role `admin`.
- owner cannot be removed by member-removal endpoint.
- owner cannot self-demote via role endpoint.
- ownership transfer changes only `libraries.owner_user_id`; membership rows are adjusted to preserve owner-admin invariant.

### 4.3 ownership transfer state machine

for a given library:
- owner = `u1` -> owner = `u2` (legal if `u2` is existing member)

idempotent repeat:
- transfer to current owner returns `200` unchanged library.

illegal:
- transfer by non-owner -> `403 E_OWNER_REQUIRED`
- transfer to non-member -> `409 E_OWNERSHIP_TRANSFER_INVALID`
- transfer on default library -> `403 E_DEFAULT_LIBRARY_FORBIDDEN`

### 4.4 backfill job state machine

states: `pending`, `running`, `completed`, `failed`.

legal transitions:
- `pending` -> `running`
- `running` -> `completed`
- `running` -> `failed`
- `failed` -> `pending` (retry)
- `completed` -> `pending` (explicit requeue)

illegal transitions:
- any transition not listed above.

---

## 5) canonical visibility and authorization contracts

### 5.1 media visibility (`can_read_media`)

media is visible to viewer if any condition holds:

1. non-default path:
- exists non-default library `l` such that:
  - viewer is a member of `l`
  - `(l, media)` exists in `library_media`

2. default intrinsic path:
- viewer owns default library `d`
- `(d, media)` exists in `default_library_intrinsics`

3. default closure path:
- viewer owns default library `d`
- exists closure edge `(d, media, source_library_id)` in `default_library_closure_edges`
- viewer currently has membership in `source_library_id`

note:
- raw presence of `(d, media)` in `library_media` is not sufficient for visibility without intrinsic or active closure-edge justification.

### 5.2 highlight and annotation visibility

highlight/annotation is visible if:
- viewer satisfies media visibility for anchor media, and
- there exists a library intersection containing anchor media where both author and viewer are members.

mutations remain author-only in s4 mvp.

### 5.3 conversation and message visibility

conversation/message is visible if:
- viewer is owner, or
- conversation is `public`, or
- conversation is `library` and there exists `conversation_shares` target library `l` where:
  - viewer is a member of `l`
  - owner is a member of `l`

write operations remain owner-only.

### 5.4 mutation authorization matrix

- rename library: admin or owner
- add/remove library media: admin or owner
- manage members/roles: admin or owner
- revoke invite: admin or owner
- transfer ownership: owner only
- delete library container: owner only
- conversation share mutation: conversation owner only
- conversation/message write/delete: conversation owner only
- highlight/annotation write/delete: highlight author only

---

## 6) api contracts

all responses use existing envelope conventions:
- success: `{ "data": ... }`
- error: `{ "error": { "code": "E_...", "message": "...", "request_id": "..." } }`

exception:
- `GET /search` keeps existing response shape in s4 for compatibility:
  - `{ "results": [...], "page": {...} }`

list endpoints in this slice use:
- new s4 list endpoints introduced in this slice use:
  - `limit` query param, default `100`, clamp `[1, 200]`.
- existing s3 conversation/message list endpoints retain current limits unless explicitly changed below:
  - default `50`, bounds `[1, 100]`.

### 6.1 invitation endpoints

#### `POST /libraries/{library_id}/invites`

auth:
- viewer must be library admin/owner member.

request:
```json
{
  "invitee_user_id": "uuid",
  "role": "member"
}
```

response `201`:
```json
{
  "data": {
    "id": "uuid",
    "library_id": "uuid",
    "inviter_user_id": "uuid",
    "invitee_user_id": "uuid",
    "role": "member",
    "status": "pending",
    "created_at": "timestamp",
    "responded_at": null
  }
}
```

errors:
- `404 E_LIBRARY_NOT_FOUND` (library missing or viewer not member, masked)
- `404 E_USER_NOT_FOUND` (invitee missing)
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`
- `403 E_FORBIDDEN` (viewer member but not admin)
- `409 E_INVITE_MEMBER_EXISTS`
- `409 E_INVITE_ALREADY_EXISTS`

#### `GET /libraries/{library_id}/invites?status=<status>&limit=<n>`

auth:
- viewer must be library admin/owner member.

query:
- `status` optional, one of `pending|accepted|declined|revoked`, default `pending`.

order:
- `created_at DESC, id DESC`.

response `200`:
```json
{
  "data": [
    {
      "id": "uuid",
      "library_id": "uuid",
      "inviter_user_id": "uuid",
      "invitee_user_id": "uuid",
      "role": "member",
      "status": "pending",
      "created_at": "timestamp",
      "responded_at": null
    }
  ]
}
```

errors:
- `404 E_LIBRARY_NOT_FOUND`
- `403 E_FORBIDDEN`

#### `GET /libraries/invites?status=<status>&limit=<n>`

auth:
- authenticated viewer.

behavior:
- returns invites where `invitee_user_id = viewer_id`.
- default `status=pending`.
- order `created_at DESC, id DESC`.

response `200`:
```json
{ "data": ["LibraryInvitationOut", "..."] }
```

#### `POST /libraries/invites/{invite_id}/accept`

auth:
- invitee only.

transactional behavior:
1. lock invite row `FOR UPDATE`.
2. if invite missing or invitee mismatch, return masked `404 E_INVITE_NOT_FOUND`.
3. if status is `accepted`, return `200` idempotent no-op.
4. if status is not `pending`, return `409 E_INVITE_NOT_PENDING`.
5. assert target library exists and is non-default.
6. insert membership `(library_id, viewer_id, role)` with `ON CONFLICT DO NOTHING`.
7. set invite `status='accepted'`, set `responded_at=now()`.
8. upsert durable backfill job row (`status='pending'`, `attempts=0`, clear error fields).
9. commit.
10. best-effort enqueue worker task after commit.

response `200`:
```json
{
  "data": {
    "invite": "LibraryInvitationOut",
    "membership": {
      "library_id": "uuid",
      "user_id": "uuid",
      "role": "member"
    },
    "idempotent": false,
    "backfill_job_status": "pending"
  }
}
```

errors:
- `404 E_INVITE_NOT_FOUND`
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`
- `409 E_INVITE_NOT_PENDING`

#### `POST /libraries/invites/{invite_id}/decline`

auth:
- invitee only.

behavior:
- `pending -> declined`
- `declined -> declined` is idempotent `200`
- other non-pending states return `409 E_INVITE_NOT_PENDING`

response `200`:
```json
{
  "data": {
    "invite": "LibraryInvitationOut",
    "idempotent": true
  }
}
```

#### `DELETE /libraries/invites/{invite_id}`

revoke invite.

auth:
- admin/owner of target library.

behavior:
- `pending -> revoked`, return `204`
- already revoked, return `204` idempotent
- `accepted|declined` returns `409 E_INVITE_NOT_PENDING`

errors:
- `404 E_INVITE_NOT_FOUND` (or masked via library non-membership)
- `403 E_FORBIDDEN`

### 6.2 member endpoints

#### `GET /libraries/{library_id}/members?limit=<n>`

auth:
- admin/owner member.

order:
- owner first
- then role rank (`admin` before `member`)
- then `created_at ASC, user_id ASC`

response `200`:
```json
{
  "data": [
    {
      "user_id": "uuid",
      "role": "admin",
      "is_owner": true,
      "created_at": "timestamp"
    }
  ]
}
```

errors:
- `404 E_LIBRARY_NOT_FOUND`
- `403 E_FORBIDDEN`

#### `PATCH /libraries/{library_id}/members/{user_id}`

auth:
- admin/owner member.

request:
```json
{ "role": "admin" }
```

behavior:
- idempotent when role is unchanged.
- owner role cannot be changed via this endpoint.
- cannot demote last admin.
- default library membership mutation forbidden.

response `200`:
```json
{ "data": "LibraryMemberOut" }
```

errors:
- `404 E_LIBRARY_NOT_FOUND`
- `404 E_NOT_FOUND` (target member missing)
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`
- `403 E_OWNER_EXIT_FORBIDDEN` (owner self-demotion attempt)
- `403 E_FORBIDDEN`
- `403 E_LAST_ADMIN_FORBIDDEN`

#### `DELETE /libraries/{library_id}/members/{user_id}`

auth:
- admin/owner member.

behavior:
- idempotent: deleting absent membership returns `204`.
- cannot remove owner.
- owner self-removal blocked (`E_OWNER_EXIT_FORBIDDEN`).
- cannot remove last admin.
- default library membership mutation forbidden.

response:
- `204 No Content`

errors:
- `404 E_LIBRARY_NOT_FOUND`
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`
- `403 E_OWNER_EXIT_FORBIDDEN`
- `403 E_LAST_ADMIN_FORBIDDEN`
- `403 E_FORBIDDEN`

### 6.3 ownership transfer endpoint

#### `POST /libraries/{library_id}/transfer-ownership`

auth:
- current owner only.

request:
```json
{ "new_owner_user_id": "uuid" }
```

transactional behavior:
1. lock library row `FOR UPDATE`.
2. require viewer is current owner.
3. require library is non-default.
4. if target already owner, return idempotent `200` unchanged.
5. require target is existing member.
6. ensure target role is `admin`.
7. update `libraries.owner_user_id = new_owner_user_id`.
8. previous owner remains `admin` by default; demotion/removal is explicit follow-up action.
9. commit.

response `200`:
```json
{ "data": "LibraryOut" }
```

errors:
- `404 E_LIBRARY_NOT_FOUND`
- `403 E_OWNER_REQUIRED`
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`
- `409 E_OWNERSHIP_TRANSFER_INVALID`

### 6.4 existing library endpoint contract updates

#### `DELETE /libraries/{library_id}`

updated rule:
- default library forbidden.
- owner only.
- admins who are not owner get `403 E_OWNER_REQUIRED`.
- no member-count restriction remains.

cascades remain standard fk behavior for `library_media`, `memberships`, `conversation_shares`, `library_invitations`, closure tables.

### 6.5 existing conversation endpoint contract updates

#### `GET /conversations?scope=<scope>&limit=<n>&cursor=<c>`

new `scope` values:
- `mine` (default): only owned
- `all`: all visible conversations (owned + shared + public)
- `shared`: visible but not owned

read visibility uses section 5.3 predicate.

response objects use updated `ConversationOut` including `owner_user_id` and `is_owner`.

ordering and cursor:
- order must be `updated_at DESC, id DESC`.
- cursor must encode tuple `(updated_at, id)`.
- tuple ordering is global across `all`, `mine`, and `shared` scopes.

limit contract (unchanged from s3):
- default `50`
- bounds `[1, 100]`

#### `GET /conversations/{conversation_id}` and `GET /conversations/{conversation_id}/messages`

- now visible to shared readers.
- return masked `404 E_CONVERSATION_NOT_FOUND` if not visible.

#### write endpoints unchanged auth

- `POST /conversations/messages`
- `POST /conversations/{id}/messages`
- stream variants
- `DELETE /conversations/{id}`
- `DELETE /messages/{id}`

remain owner-only.

### 6.6 conversation share endpoint contracts

#### `GET /conversations/{conversation_id}/shares`

- owner-only read of share targets.

#### `PUT /conversations/{conversation_id}/shares`

request:
```json
{
  "sharing": "library",
  "library_ids": ["uuid"]
}
```

rules:
- preserve s3 invariants for `private|library` share consistency.
- owner must be member of each share target.
- default library targets are forbidden.

errors:
- `403 E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`
- existing s3 share errors remain.

### 6.7 highlight endpoint contract updates

#### `GET /fragments/{fragment_id}/highlights?mine_only=<bool>`

- default `mine_only=true` for backward-compatible behavior.
- when `mine_only=true`, filter to author = viewer.
- when `mine_only=false`, return all visible highlights under section 5.2.

response keeps existing shape:
```json
{
  "data": {
    "highlights": ["HighlightOut", "..."]
  }
}
```

#### `GET /highlights/{highlight_id}`

- visible if section 5.2 allows.

#### highlight/annotation mutate endpoints

- remain author-only in s4 mvp.
- unauthorized mutation attempts are masked as `404 E_MEDIA_NOT_FOUND`.

### 6.8 search endpoint contract updates

#### `GET /search`

search visibility must align with section 5 predicates.

response compatibility:
- preserve existing non-envelope response shape in s4:
```json
{
  "results": ["SearchResultOut", "..."],
  "page": { "next_cursor": null, "has_more": false }
}
```

required updates:
- conversation scope authorization must use shared-read visibility (owner/public/library-share), not owner-only helper.
- annotation search visibility must match section 5.2 (not viewer-owner-only filter).
- message search visibility for `scope=all` and `scope=conversation:*` must match section 5.3.
- message search visibility for `scope=library:*` must be enabled and constrained by the target library:
  - include message row only if its conversation is shared to `scope_library_id`.
  - still enforce section 5.3 conversation visibility predicate.
  - do not include owner/public conversations that are not shared to `scope_library_id`.
- unauthorized scope objects remain masked (`404`) with preserved codes:
  - unauthorized `media:*` scope -> `404 E_NOT_FOUND`
  - unauthorized `library:*` scope -> `404 E_NOT_FOUND`
  - unauthorized `conversation:*` scope -> `404 E_CONVERSATION_NOT_FOUND`

### 6.9 backfill operator endpoint contract

#### `POST /internal/libraries/backfill-jobs/requeue`

purpose:
- explicit operator recovery path for failed backfill jobs.

auth:
- internal-only route; not exposed through public user bff routes.
- caller must satisfy existing internal service authentication policy.
- no next.js `/api/*` proxy route is added for this endpoint in s4.

request:
```json
{
  "default_library_id": "uuid",
  "source_library_id": "uuid",
  "user_id": "uuid"
}
```

behavior:
1. lock target job row.
2. if row missing, return `404 E_NOT_FOUND`.
3. if current status is `running`, return `200` idempotent no-op with current status.
4. otherwise transition `pending|failed|completed -> pending`.
5. reset `attempts=0`, clear `last_error_code`, clear `finished_at`, update `updated_at`.
6. commit and enqueue worker task (enqueue failure does not roll back committed state).

response `200`:
```json
{
  "data": {
    "default_library_id": "uuid",
    "source_library_id": "uuid",
    "user_id": "uuid",
    "status": "pending"
  }
}
```

---

## 7) closure materialization and strict revocation mechanics

### 7.1 closure write rules

on add media to non-default library `L`:
- insert `(L, media)` into `library_media`.
- for each member `u` of `L`:
  - insert `(d(u), media, L)` into `default_library_closure_edges`.
  - insert `(d(u), media)` into `library_media` (materialization only).

on remove media from non-default library `L`:
- delete `(L, media)` from `library_media`.
- delete all closure edges `(d(u), media, L)`.
- for each affected `d(u)`, gc materialized default row if no intrinsic and no remaining closure edge.

on media created/uploaded directly by user into default library:
- insert into `library_media(d(u), media)`.
- insert into `default_library_intrinsics(d(u), media)`.

on remove media from default library `d(u)`:
- delete intrinsic row `(d(u), media)` from `default_library_intrinsics`.
- do not delete closure edges.
- if at least one active closure edge remains for `(d(u), media)`, keep `library_media(d(u), media)`.
- if no intrinsic and no closure edge remain, gc removes `library_media(d(u), media)`.

note:
- s4 mvp has no per-user suppression feature for closure-derived media while membership is still active.

### 7.2 membership accept/revoke rules

on invite accept:
- membership created immediately.
- durable backfill job row upserted to `pending`.
- async worker materializes closure edges and default rows for existing media in source library.

on membership revoke/remove:
- delete closure edges for `(d(user), *, source_library_id)`.
- gc default materialized rows where neither intrinsic nor remaining closure edge exists.

### 7.3 gc rule (normative)

for any candidate `(d, media)`:
- delete from `library_media` iff:
  - not in `default_library_intrinsics`, and
  - no rows in `default_library_closure_edges` for `(d, media)`.

### 7.4 worker contract

task name:
- `backfill_default_library_closure_job(default_library_id, source_library_id, user_id, request_id=None)`

worker behavior:
1. claim pending job row (`pending -> running`).
2. insert missing closure edges for all media currently in source library.
3. insert corresponding default `library_media` rows.
4. set job `completed` with `finished_at`.
5. on failure set `failed`, increment `attempts`, set `last_error_code`.

retry policy:
- automatic retries use fixed delays: `1m, 5m, 15m, 1h, 6h`.
- after 5 failed attempts, job remains `failed` until explicit requeue.
- explicit requeue transitions `failed -> pending` and resets attempt counter.

idempotency:
- all inserts use `ON CONFLICT DO NOTHING`.

### 7.5 masking policy (normative)

- if resource is not visible to caller: masked `404`.
- if resource is visible but caller lacks required capability: `403`.
- if operation violates transition/state precondition: `409`.

invite/member-specific consequences:
- unknown invite id for caller context -> `404 E_INVITE_NOT_FOUND`.
- non-member library access on admin routes -> `404 E_LIBRARY_NOT_FOUND`.
- member without admin role on admin routes -> `403 E_FORBIDDEN`.

---

## 8) error codes (s4 additions)

| code | http | meaning |
|---|---:|---|
| `E_USER_NOT_FOUND` | 404 | invitee user id does not exist |
| `E_INVITE_NOT_FOUND` | 404 | invite missing or not visible to caller |
| `E_INVITE_ALREADY_EXISTS` | 409 | pending invite already exists for `(library, invitee)` |
| `E_INVITE_MEMBER_EXISTS` | 409 | invitee is already a member |
| `E_INVITE_NOT_PENDING` | 409 | invite transition attempted from terminal state |
| `E_OWNER_REQUIRED` | 403 | action requires current owner |
| `E_OWNER_EXIT_FORBIDDEN` | 403 | owner attempted exit path before transfer |
| `E_OWNERSHIP_TRANSFER_INVALID` | 409 | transfer target invalid (for example non-member) |
| `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN` | 403 | default library cannot be share target |

existing reused codes remain authoritative where applicable:
- `E_DEFAULT_LIBRARY_FORBIDDEN`
- `E_LAST_ADMIN_FORBIDDEN`
- `E_LIBRARY_NOT_FOUND`
- `E_CONVERSATION_NOT_FOUND`
- `E_FORBIDDEN`
- s3 share errors (`E_SHARE_REQUIRED`, `E_SHARES_NOT_ALLOWED`)

---

## 9) invariants (must always hold)

1. default library is non-shareable and non-invitable.
2. library owner is always an admin member of that library.
3. non-owner admins can never delete library container or transfer ownership.
4. owner cannot self-remove or self-demote without prior ownership transfer.
5. invite accept transaction atomically records invite state + membership + backfill intent row.
6. read visibility is never blocked on backfill completion.
7. revocation affects all new requests immediately after commit.
8. default-library materialized media is justified by intrinsic row or active closure edge.
9. conversation share targets must be non-default libraries.
10. write rights for conversations/messages stay owner-only in s4.
11. write rights for highlights/annotations stay author-only in s4.
12. removing media from default library removes intrinsic ownership, not active closure edges.
13. conversation list pagination order is always `updated_at DESC, id DESC`.
14. s4 response schema evolution is additive-only for existing endpoints.

---

## 10) acceptance scenarios

### scenario 1: invite + immediate access

given:
- user a is admin in non-default library `L`
- media `M` exists in `L`

when:
- a invites b as member
- b accepts

then:
- b membership exists immediately
- b can read `M` immediately before any backfill worker runs
- invite status is `accepted`
- backfill job row exists and is `pending|running|completed`

### scenario 2: strict revocation

given:
- b previously had access to `L` media through membership

when:
- b is removed from `L`

then:
- subsequent reads by b that depended on `L` are denied immediately
- default-library materialized rows without intrinsic/remaining edges are gc'd

### scenario 3: default library invite forbidden

when:
- admin calls `POST /libraries/{default_library_id}/invites`

then:
- `403 E_DEFAULT_LIBRARY_FORBIDDEN`

### scenario 4: default library conversation share forbidden

when:
- owner calls `PUT /conversations/{id}/shares` including default library id

then:
- `403 E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`

### scenario 5: admin cannot delete container

given:
- user b is admin but not owner of shared library `L`

when:
- b calls `DELETE /libraries/{L}`

then:
- `403 E_OWNER_REQUIRED`

### scenario 6: owner transfer then exit

given:
- a owns `L`, c is member

when:
- a transfers ownership to c
- a is later demoted or removed by admin flow

then:
- transfer succeeds with c as owner
- exit operation is allowed only after transfer

### scenario 7: shared conversation read

given:
- conversation `C` is shared to non-default library `L`
- b is member of `L` and not owner of `C`

when:
- b calls conversation read endpoints

then:
- `GET /conversations/{C}` and `GET /conversations/{C}/messages` succeed
- owner-only write/delete endpoints remain denied

### scenario 8: shared highlights visible

given:
- media `M` is in shared library `L`
- a and b are members of `L`
- a authored highlight `H` on fragment of `M`

when:
- b lists highlights for that fragment

then:
- `H` is returned with `author_user_id=a`
- b cannot mutate `H`

### scenario 8b: highlight list default remains mine-only

given:
- media is shared and viewer can see other users' highlights

when:
- viewer calls `GET /fragments/{id}/highlights` without `mine_only`

then:
- response includes only viewer-authored highlights.

when:
- viewer retries with `mine_only=false`

then:
- response includes visible highlights from other authors too.

### scenario 9: invite idempotency

given:
- invite `I` is already accepted by b

when:
- b retries accept endpoint

then:
- endpoint returns `200` idempotent no-op
- no duplicate membership rows

### scenario 10: revoke idempotency

given:
- pending invite `I` has already been revoked

when:
- admin retries revoke endpoint

then:
- endpoint returns `204`

### scenario 11: conversation list deterministic ordering

given:
- owned and shared conversations mixed for viewer

when:
- viewer calls `GET /conversations?scope=all`

then:
- order is `updated_at DESC, id DESC`
- pagination cursor based on `(updated_at,id)` yields no duplicates/skips.

### scenario 12: default-library remove under active closure edge

given:
- media `M` exists in viewer default library via both intrinsic and closure edge from shared library `L`

when:
- viewer removes `M` from default library

then:
- intrinsic row is removed
- closure edge remains
- `M` remains visible/materialized while viewer is still member of `L`.

when:
- membership in `L` is later revoked and no other justification remains

then:
- `M` is no longer visible and materialized default row is gc'd.

### scenario 13: shared conversation search scope works

given:
- conversation `C` is shared to non-default library `L`
- b is member of `L` and not owner of `C`

when:
- b calls `GET /search?q=...&scope=conversation:C&types=message`

then:
- request succeeds
- only messages from `C` are returned.

### scenario 14: shared annotation search visibility aligns with highlight visibility

given:
- media `M` is visible to both a and b via shared membership
- a authored highlight/annotation on `M`

when:
- b calls `GET /search?q=...&types=annotation`

then:
- b can receive that annotation result only when section 5.2 visibility holds.

### scenario 15: library-scope message search is constrained to that library

given:
- `C1` is shared to library `L1`
- `C2` is shared to library `L2`
- viewer `b` is member of `L1` and not member of `L2`

when:
- `b` calls `GET /search?q=...&scope=library:L1&types=message`

then:
- messages from `C1` may appear
- messages from `C2` do not appear
- messages from conversations not shared to `L1` do not appear.

---

## 11) implementation constraints to carry into l3

- route handlers remain transport-only; no raw db access in routes.
- all visibility checks must call canonical service predicates, not ad-hoc sql fragments.
- all closure and backfill writes must be idempotent (`ON CONFLICT DO NOTHING` where applicable).
- no db triggers for business logic in v1; service layer owns invariants.
- preserve existing request/response envelope contract.
- preserve existing `/search` response shape in this slice; defer envelope normalization to a future versioned change.
- preserve single-author conversation write model.
- `can_read_media` in `auth/permissions.py` remains the single authorization source for media readability.
- provenance/closure updates must be applied across every default-library writer path in the same release:
  - libraries media add/remove flows
  - upload init + dedupe winner ensure path
  - provisional from-url media creation path
  - ingest dedupe winner attach path
- conversation read authorization must be centralized so `/conversations*`, `/search scope=conversation:*`, and `/search scope=library:*` use identical base visibility logic with scope-specific filters layered on top.
- by end of slice, old owner-only visibility helpers that conflict with s4 shared-read semantics must be removed or rewritten; duplicate auth paths are not allowed.
- backfill recovery uses explicit operator requeue flow, not ad-hoc database edits.
- preserve existing public pagination contracts for conversation/message lists unless explicitly changed in this spec.
