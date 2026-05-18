# Workspace Session Restore

## Status

Implementation spec. **Hard cutover** — single code path, no feature flag, no
legacy fallback. This document is temporary scaffolding: delete it once the
feature is verified in production and migrate any durable rule into
`docs/rules/` (see [Cutover & Cleanup](#cutover--cleanup)).

## Summary

When a user reopens the app on a device, **silently restore** the set of
workspace panes ("tabs") that were open the last time the app was used
**on that device** — no prompt, no banner, no confirmation. Persist the
workspace to the backend, keyed per device. If the device has no session
of its own (new install, cleared storage), the app instead silently
restores the most recent session from another of the user's devices.

Today the workspace lives only in the URL (`?wsv=4&ws=<base64>` via
`apps/web/src/lib/workspace/urlCodec.ts`). A cold open of the base URL —
which is *every* Android launch and any web launch from a bookmark — drops
all tabs. This feature adds a server-side mirror of the already-serialized
`WorkspaceStateV4` object plus a restore path on cold boot.

## Goals

- A returning device silently restores its own last workspace on cold open.
- A device with no session of its own silently picks up the most recent
  session from another device (cross-device fallback).
- Capture is reliable on web, mobile web, and inside the Android WebView,
  with **no native Android code and no JS bridge**.
- The persisted state stays byte-compatible with the existing
  `WorkspaceStateV4` schema, validator, and version-migration machinery.
- The backend is a dumb per-`(user, device)` blob store; workspace
  semantics stay owned by the web app.

## Non-Goals

- **Live mirroring / realtime propagation.** A device sees another device's
  changes only on its own next cold open. No websockets, no polling.
- **A user setting** to enable/disable sync. The feature is always on.
- **A restore prompt, banner, or confirmation UI.** Restore is silent —
  it never asks. See [D4](#key-decisions).
- **Per-pane scroll position and typography.** Already owned by
  `reader_media_state` and `reader_profiles`; the workspace session stores
  only *which* panes are open. The layers compose — see [D8](#key-decisions).
- **Device naming / a device-management UI.** A device is an opaque id.
- **Restoring transient pane content** (chat drafts, unsaved notes). Drafts
  already persist in `localStorage` independently.
- **Pre-validating pane resource liveness on restore.** A pane pointing at a
  deleted resource is restored and renders its own not-found state.
- **Native Android persistence**, `WebView.saveState`, or a JS bridge.
- The browser extension (`apps/extension`) is out of scope.

## Glossary

- **Pane** — one tiled panel in the workspace. Shape:
  `WorkspacePaneStateV4 { id, href, widthPx, visibility }`.
- **Workspace / tab set** — `WorkspaceStateV4 { schemaVersion: 4,
  activePaneId, panes[] }`. Max 12 panes. This is "the tabs."
- **Session** — a persisted snapshot of one device's workspace.
- **Device** — a client installation, identified by an opaque
  `installationId` in `localStorage`. The Android WebView and a desktop
  browser are distinct devices even on one physical machine.
- **Cold open** — an app boot whose entry URL carries **no `ws=` param**.
  Every Android launch and every web launch from the base URL is a cold
  open. A reload of a URL that already carries `ws=`, or following a shared
  deep link, is **not** a cold open.

## Target Behaviour

### Capture — persisting the workspace

- The workspace is persisted continuously, not on a single "close" event.
  Every workspace mutation (open / close / navigate / resize / minimize /
  restore / activate) schedules a **debounced** `PUT` of the current
  `WorkspaceStateV4` after `WORKSPACE_SESSION_SYNC_DEBOUNCE_MS` (1000 ms).
- On `visibilitychange → hidden` and on `pagehide`, any pending write is
  **flushed immediately** with `fetch(..., { keepalive: true })`.
- "What was open at close" is therefore simply "the last persisted state" —
  there is no dependence on an unreliable close event.
- `visibilitychange → hidden` fires inside the Android WebView when Android
  backgrounds it, so this single web-side mechanism covers all platforms.
- Writes are fire-and-forget. A failed write is a narrowed, justified-ignored
  error (`justify-ignore-error`); it never blocks the UI and is superseded by
  the next write.

### Restore — cold open

1. On boot, the workspace hydrates from the URL exactly as today.
2. If the entry is **not** a cold open (URL carries `ws=`), stop. The URL is
   authoritative; no session fetch, no restore.
3. If the entry **is** a cold open, fire `GET /me/workspace-session` for this
   device while the default workspace renders.
4. When the response arrives, decide what to restore (see below). If there is
   something worth restoring, **apply it silently** — `applyRestoredState`
   replaces the workspace with no prompt and no banner. The user simply sees
   their tabs come back, the same way the reader silently resumes a reading
   position.

A fetched session is always passed through `sanitizeWorkspaceState`
(`apps/web/src/lib/workspace/schema.ts`) — which version-gates, caps at
`MAX_PANES`, and drops malformed panes — and then through a **platform
filter** that drops panes whose `href` is not permitted on the current
platform (`isAndroidShellRestrictedHref` in
`apps/web/src/lib/androidShell.ts`).

A session is **non-trivial** (worth restoring) if, after sanitize + filter,
it has more than one pane, or its single pane's `href` is not
`WORKSPACE_DEFAULT_FALLBACK_HREF` (`/libraries`).

What is restored, in priority order:

1. If this device's **own** session is non-trivial → restore the own session.
2. Else if the **most recent session from another device** is non-trivial →
   restore that (cross-device fallback).
3. Else → restore nothing; the default workspace stands.

The restore is applied **only if the user has not already changed the
workspace** while the fetch was in flight — a baseline equality check
(`workspaceStatesEqual`) compares the live state against the state captured
at fetch start. If the user opened, closed, or navigated a pane in that
window, the restore is skipped so it cannot clobber a deliberate action.

### Capture suspension on cold open (critical correctness rule)

On a cold open the default workspace renders *before* the session fetch
resolves. If capture ran immediately it would `PUT` the default workspace
and **destroy the saved session before it could be restored**.

Therefore capture is **suspended on cold open** and armed only once the
fetch resolves and the restore decision is made. State machine:

```
                 ┌────────────── boot ──────────────┐
                 │                                   │
        cold open (no ws=)                  non-cold open (ws= present)
                 │                                   │
        capture = SUSPENDED                  capture = ARMED
        fetch GET /me/workspace-session              │
                 │                                   ▼
   ┌─────────────┼───────────────┐          (URL state is the
   │             │               │           device's session)
non-trivial   trivial / none   fetch fails
session        │               │
   │           │               │
   ▼           │               │
user has NOT changed workspace? │
   │ yes  │ no │               │
   ▼      │    │               │
apply     │    │               │
restored  │    │               │
state     │    │               │
silently  │    │               │
   │      │    │               │
   └──────┴────┴──── capture = ARMED ────┘
```

Once armed, capture stays armed for the rest of the session. While
suspended, both the debounced write and the `visibilitychange`/`pagehide`
flush are no-ops. Two consequences:

- A user who cold-opens and closes again before the fetch resolves
  **preserves** their previous saved session — capture never armed.
- A user who changes the workspace during the in-flight fetch keeps that
  change: the baseline equality check skips the silent restore, then
  capture arms and the deliberate change is what gets persisted.

### Platform notes

- **Web (desktop)** — tiled multi-pane workspace. Full behaviour applies.
- **Mobile web** — responsive layout shows one pane at a time plus a
  switcher. The full pane set is still captured and restored as data; the
  layout simply presents it differently. Desktop `widthPx` values are
  restored verbatim and ignored by the mobile layout.
- **Android** — thin WebView shell (`apps/android`, `MainActivity.kt`).
  Every launch loads the base URL → always a cold open → always eligible for
  restore. No native code, no `addJavascriptInterface` bridge, no
  `WebView.saveState`. The web app's own `visibilitychange` handler is the
  capture trigger.

## Key Decisions

- **D1 — Session restore, not live mirroring.** Restore the last workspace
  on open; do not continuously mirror devices. Live mirroring makes
  concurrently-open devices fight and requires realtime infra the repo does
  not have. Matches the Chrome/Safari model.
- **D2 — Per-device storage.** One row per `(user_id, device_id)`. A device
  restores its own session; this is also why there is **no cross-device
  write conflict** — two devices never write the same row.
- **D3 — Cross-device fallback.** When a device has no non-trivial session
  of its own, the app silently restores the most recent session from another
  device. This is a read-only feature, not a compatibility fallback.
- **D4 — Silent restore, no prompt.** A cold open silently restores the last
  saved session — no banner, no confirmation. This matches the extant
  `apps/web/src/lib/reader/useReaderResumeState.ts` pattern: the reader
  restores the last reading position silently, without asking. A workspace
  is the same kind of resumable state, so it restores the same way; a
  confirmation prompt was the un-idiomatic part. The restore stays safe
  without a prompt because (a) a `ws=` URL is authoritative and suppresses
  restore entirely, and (b) a workspace change made during the in-flight
  fetch is detected by a baseline equality check and is never clobbered.
- **D5 — No user setting.** Sync is always on. No toggle, no persisted
  preference.
- **D6 — Capture is continuous + debounced, not close-triggered.** Mirrors
  `apps/web/src/lib/reader/useReaderResumeState.ts`. Close events are a
  best-effort optimization; the debounced write is the guarantee.
- **D7 — Capture is suspended on cold open** until the restore decision is
  made. See [the state machine](#capture-suspension-on-cold-open-critical-correctness-rule).
- **D8 — The workspace session stores only the pane set.** Scroll position
  is owned by `reader_media_state`, typography by `reader_profiles`. A
  restored `/media/123` pane independently restores its own scroll via
  `GET /api/media/123/reader-state`. No duplication of state.
- **D9 — The backend is a dumb blob store.** It persists the `state` JSON
  per `(user, device)` with last-write-wins. The canonical workspace schema
  and all "is this pane valid" logic stay in `apps/web/src/lib/workspace/`.
  The backend does not know about routes, `MAX_PANES`, or pane liveness.
- **D10 — `state` stored as `jsonb`,** verbatim `WorkspaceStateV4` (camelCase
  keys). Not base64 — base64 is a URL-transport concern only. Not `text`
  (`json-values.md`).
- **D11 — Last-write-wins by `updated_at`.** The only writer of a row is its
  own device (possibly two browser tabs of it); LWW is correct and the loss
  on conflict is a seconds-old tab set. The upsert uses an explicit
  `SELECT` then `INSERT`/`UPDATE` inside a `SERIALIZABLE` transaction —
  **not** `INSERT ... ON CONFLICT** (`database.md` Query Patterns; note the
  pre-rule `on_conflict_do_update` in `python/nexus/services/media.py` is
  not a template).
- **D12 — No `ON DELETE CASCADE`.** Per `database.md`, the `user_id` FK uses
  the default non-cascading behavior; cleanup is explicit application code
  (see [the user-deletion integration point](#edge-cases--failure-modes)).
- **D13 — Device identity is a new client primitive:** an opaque
  `installationId` UUID in `localStorage`. It is a private `*Id`
  (`keys-and-identities.md`) — never shown to users.
- **D14 — No realtime, no polling.** Cross-device freshness is "on next cold
  open," consistent with reader/podcast state and `polling.md`.
- **D15 — Hard cutover.** No env flag, no kill-switch, no dual path. The
  feature is on for everyone on merge.

## Architecture

Layering follows `docs/rules/layers.md`:

```
  ┌─────────────────────────── apps/web (one client; web + mobile + Android WebView) ──┐
  │  WorkspaceStoreProvider (store.tsx)                                                │
  │    ├─ capture:  useWorkspaceSession → debounced PUT + visibilitychange flush        │
  │    └─ restore:  cold-open detect → GET → sanitize + platform filter →               │
  │                 applyRestoredState (silent hydrate, baseline-guarded)               │
  └───────────────┬─────────────────────────────────────────────────────────────────┘
                  │  /api/me/workspace-session   (client calls /api/* only)
  ┌───────────────▼─────────────────────────────────────────────────────────────────┐
  │  BFF proxy route  apps/web/src/app/api/me/workspace-session/route.ts               │
  │    verifies session via lib/auth/dal.ts, attaches bearer token, NO business logic  │
  └───────────────┬─────────────────────────────────────────────────────────────────┘
                  │  GET/PUT /me/workspace-session
  ┌───────────────▼─────────────────────────────────────────────────────────────────┐
  │  FastAPI route  routes/workspace_session.py   (thin: one service call each)        │
  │  Service  services/workspace_sessions.py   (SERIALIZABLE upsert, LWW, no HTTP)      │
  │  Model  WorkspaceSession   ·   Table  workspace_sessions (jsonb state)              │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

Data flow:

- **Capture:** workspace mutation → store effect → debounce 1 s → BFF `PUT` →
  FastAPI → service `SELECT`+`UPDATE`/`INSERT` (SERIALIZABLE) → row updated.
- **Restore:** cold open → BFF `GET` → FastAPI → service two `SELECT`s
  (`own`, `most_recent_elsewhere`) → client `sanitizeWorkspaceState` +
  platform filter → baseline equality check → silent `hydrate` dispatch.

## Data Model

### Table `workspace_sessions`

New Alembic migration (next sequential revision; `0105` at time of writing),
`migrations/alembic/versions/`.

| Column        | Type          | Notes                                             |
|---------------|---------------|---------------------------------------------------|
| `id`          | `uuid` PK     | `default gen_random_uuid()`                       |
| `user_id`     | `uuid` not null | FK → `users(id)`, **no cascade** (`database.md`) |
| `device_id`   | `text` not null | the client `installationId`                     |
| `state`       | `jsonb` not null | verbatim `WorkspaceStateV4`                      |
| `created_at`  | `timestamptz` not null | `default now()` (`database.md`)            |
| `updated_at`  | `timestamptz` not null | `default now()`; set to `now()` on every write |

- Unique constraint `uq_workspace_sessions_user_device` on
  `(user_id, device_id)` — the real local alternate key, and the lookup
  index for both `GET` and the upsert `SELECT`.
- Check constraint `ck_workspace_sessions_state_object`:
  `jsonb_typeof(state) = 'object'` — a cheap defect catcher, consistent with
  `reader_media_state`'s locator check.
- **No additional index.** "Most recent across devices" scans a single
  user's handful of rows; an index would be speculative (`database.md`
  Indexes).

### `state` jsonb shape

The verbatim `WorkspaceStateV4` object — canonical definition in
`apps/web/src/lib/workspace/schema.ts`, **not** redefined here:

```jsonc
{
  "schemaVersion": 4,
  "activePaneId": "pane-…",
  "panes": [
    { "id": "pane-…", "href": "/media/…", "widthPx": 720, "visibility": "visible" }
  ]
}
```

When `schema.ts` advances to V5, the stored blob is migrated by the existing
`sanitizeWorkspaceState` version gate on read — no backend change.

### Device identity

`installationId`: a `crypto.randomUUID()` value generated lazily on first
access and stored in `localStorage` under `nexus.installationId.v1`. It
persists across launches, including inside the Android WebView (WebView
`localStorage` is durable). Clearing browser data resets it — the device is
then treated as new, which is correct (the cross-device fallback covers it).

## API Contract

Standard envelope (`python/nexus/responses.py`):
`{ "data": … }` / `{ "error": { "code", "message", "request_id" } }`.
Envelope and request fields are `snake_case`; the `state` blob is the
verbatim camelCase `WorkspaceStateV4`.

### `GET /me/workspace-session?device_id=<id>`

Returns this device's own session and the most recent session from any
*other* device of the same user.

```jsonc
{ "data": {
  "device_id": "<id>",
  "own":                  { "state": { … }, "updated_at": "2026-05-17T…Z" } | null,
  "most_recent_elsewhere":{ "state": { … }, "updated_at": "2026-05-16T…Z" } | null
}}
```

`device_id` only ever selects among the caller's own rows (the query is
scoped by `viewer.user_id` from the JWT), so it carries no cross-user risk.

### `PUT /me/workspace-session`

```jsonc
// request
{ "device_id": "<id>", "state": { "schemaVersion": 4, "activePaneId": "…", "panes": [ … ] } }
// 200 response
{ "data": { "state": { … }, "updated_at": "2026-05-17T…Z" } }
```

Upserts the `(viewer.user_id, device_id)` row. Last-write-wins.

### Validation & errors

The backend validates only enough to not store garbage (D9):

- `device_id`: non-empty string, `max_length 200`.
- `state`: a JSON object whose `schemaVersion` is an integer, and whose
  serialized size is `<= WORKSPACE_SESSION_MAX_STATE_BYTES` (65536). Full
  pane-shape validation is the web app's job via `sanitizeWorkspaceState`.
- Pydantic models use `ConfigDict(extra="forbid")`.

Errors: invalid body → `E_INVALID_REQUEST` (400). Oversized `state` →
`E_INVALID_REQUEST`. Auth is handled by existing middleware
(`E_UNAUTHENTICATED` → 401, client redirects via `apiFetch`).

## Client Design

### Device id — `lib/workspace/deviceId.ts`

`getInstallationId(): string` — reads `nexus.installationId.v1` from
`localStorage`, generating and storing a UUID on first call. Pure and
synchronous; safe to call before the first capture write.

### Session sync client + helpers — `lib/workspace/sessionSync.ts`

- `fetchWorkspaceSession(deviceId)` / `putWorkspaceSession(deviceId, state)` —
  typed wrappers over `apiFetch` (and a `keepalive` `fetch` variant for the
  unload flush, mirroring `globalPlayer.tsx`).
- `isColdOpen(url): boolean` — true when the URL carries no `ws=` param.
- `prepareRestoredState(rawState): WorkspaceStateV4` — `sanitizeWorkspaceState`
  then drop platform-forbidden panes; if the result is empty, return the
  default workspace.
- `isNonTrivialSession(state): boolean` — see [Restore](#restore--cold-open).
- `workspaceStatesEqual(a, b): boolean` — deep equality for write
  de-duplication (`json-values.md`: never `===` on structural JSON).

### Capture + restore — `lib/workspace/useWorkspaceSession.ts`

A hook consumed by `WorkspaceStoreProvider` (`store.tsx`). Its signature is
`useWorkspaceSession(state, mounted, applyRestoredState)`; it returns
nothing. It owns the `captureArmed` flag (a ref) and implements the
[state machine](#capture-suspension-on-cold-open-critical-correctness-rule):

- **Restore:** on mount, once `mounted`, if not a cold open it arms capture
  immediately and stops (the URL is authoritative). On a cold open it
  captures the current state as a `baseline`, then fetches the session.
  When the fetch resolves it picks the own session if non-trivial, else the
  most-recent-elsewhere session if non-trivial. It applies that session
  **silently** via `applyRestoredState` — *unless* the live state no longer
  equals the `baseline` (`workspaceStatesEqual`), meaning the user changed
  the workspace mid-fetch, in which case the restore is skipped. Either way
  it then arms capture.
- **Capture:** on every workspace state change, if `captureArmed` and the
  state differs (`workspaceStatesEqual`) from the last saved state, schedule
  a debounced `putWorkspaceSession`. Register `visibilitychange` and
  `pagehide` listeners that flush a pending write immediately with
  `keepalive`. The last-saved ref is seeded with the initial state so the
  hydrated state is never written back (the pattern in
  `useReaderResumeState.ts`).

### Store integration — `store.tsx`

`WorkspaceStoreProvider` calls `useWorkspaceSession(state, mounted,
applyRestoredState)`, where `applyRestoredState` is a memoized callback that
dispatches `{ type: "hydrate", state }`. No reducer actions change; restore
reuses the existing `hydrate` action. There is no prompt component and no
restore-offer state to thread through.

## Final State

When complete, the codebase has — as a single un-flagged code path:

- `workspace_sessions` table + `WorkspaceSession` model.
- `services/workspace_sessions.py`: `get_session`, `get_most_recent_elsewhere`,
  `put_session` (SERIALIZABLE upsert), `delete_sessions_for_user`.
- `routes/workspace_session.py`: `GET` + `PUT /me/workspace-session`,
  registered in `routes/__init__.py`.
- BFF route `apps/web/src/app/api/me/workspace-session/route.ts`.
- `lib/workspace/deviceId.ts`, `sessionSync.ts`, `useWorkspaceSession.ts`.
- `WorkspaceStoreProvider` captures continuously and silently restores on
  cold open. No prompt component.
- The user-deletion path explicitly deletes `workspace_sessions` rows.
- Tests at every layer (see [Test Plan](#test-plan)).

There is **no** feature flag, no migration shim, no dual old/new path, and
no code branch that references this document.

## Files

### New

| File | Purpose |
|------|---------|
| `migrations/alembic/versions/0105_workspace_sessions.py` | Create `workspace_sessions`. |
| `python/nexus/schemas/workspace_session.py` | Pydantic request/response DTOs. |
| `python/nexus/services/workspace_sessions.py` | Persistence + LWW upsert + user cleanup. |
| `python/nexus/api/routes/workspace_session.py` | `GET`/`PUT /me/workspace-session`. |
| `apps/web/src/app/api/me/workspace-session/route.ts` | BFF proxy (`GET` + `PUT`). |
| `apps/web/src/lib/workspace/deviceId.ts` | `installationId` accessor. |
| `apps/web/src/lib/workspace/sessionSync.ts` | API client + cold-open / sanitize / non-trivial helpers. |
| `apps/web/src/lib/workspace/useWorkspaceSession.ts` | Capture + silent-restore hook; `captureArmed` state machine. |
| `python/tests/test_workspace_sessions.py` | Backend unit + integration tests. |
| `apps/web/src/lib/workspace/sessionSync.test.ts` | Client unit tests. |
| `e2e/tests/workspace-session-restore.spec.ts` | End-to-end restore flow. |

### Modified

| File | Change |
|------|--------|
| `python/nexus/db/models.py` | Add `WorkspaceSession` model. |
| `python/nexus/api/routes/__init__.py` | Register the new router. |
| `apps/web/src/lib/workspace/store.tsx` | Wire `useWorkspaceSession` into `WorkspaceStoreProvider`. |
| User-deletion code path | Call `delete_sessions_for_user` (see Edge Cases). |

Exact module paths follow the established structure; confirm against the repo
at implementation time.

## Rules Compliance

| Rule (`docs/rules/…`) | How this spec complies |
|-----------------------|------------------------|
| `database.md` — UUID PK, `created_at`, `timestamptz` | `workspace_sessions` has a UUID PK, `created_at`, `updated_at`, all `timestamptz`. |
| `database.md` — no `INSERT ... ON CONFLICT` | Upsert is explicit `SELECT` then `INSERT`/`UPDATE`. |
| `database.md` — no `ON DELETE CASCADE` | `user_id` FK is non-cascading; cleanup is explicit (D12). |
| `database.md` — no speculative indexes | Only the `(user_id, device_id)` unique constraint. |
| `concurrency.md` — SERIALIZABLE, no extra locks | Upsert runs in a SERIALIZABLE transaction; no `SELECT FOR UPDATE`. |
| `polling.md` — avoid polling | No polling, no realtime; cross-device freshness on next open (D14). |
| `layers.md` — BFF has no business logic; client uses `/api/*` | BFF route only proxies + attaches auth; business logic in the FastAPI service. |
| `keys-and-identities.md` — `*Id` is private | `installationId` is opaque and never user-visible (D13). |
| `json-values.md` — `jsonb`, typed DTOs, deep equality | `state` is `jsonb`; DTOs typed; write de-dup uses `workspaceStatesEqual`. |
| `control-flow.md` — exhaustive matching, narrowed errors | Exhaustive on `visibility` and capture-state; the background-sync catch is narrowed with `justify-ignore-error`. |
| `errors.md` — errors vs defects | Sync network failure = handled error; corrupt `state` degrades via `sanitizeWorkspaceState`; "no session" is a modeled `null` classified at the boundary. |
| `correctness.md` — validate at ingress | Pydantic validates the API ingress; `sanitizeWorkspaceState` validates the workspace-shape ingress in the client. |
| `timing.md` / `naming.md` — named timing constants | `WORKSPACE_SESSION_SYNC_DEBOUNCE_MS`, `WORKSPACE_SESSION_MAX_STATE_BYTES`. |
| `simplicity.md` — minimal surface | Backend is a dumb store; no liveness fan-out on restore; reuse `hydrate`. |
| `cleanliness.md` — no shims, no dead era code | Hard cutover, no flag; this doc is deleted on completion. |
| `testing_standards.md` — real Postgres, no MSW, assert via API | Integration tests use real Postgres; E2E hits the real stack; assert via API. |

## Edge Cases & Failure Modes

- **Cold open, user closes before the fetch resolves** — capture never armed
  → no write → previous saved session preserved.
- **Cold open, user changes the workspace while the fetch is in flight** —
  the baseline equality check fails → silent restore is skipped → the
  deliberate change stands and is what capture persists.
- **Stale pane (deleted resource)** — restored; the pane renders its own
  not-found state. No pre-flight liveness check (D8, Non-Goals).
- **Platform-forbidden pane** — dropped by the platform filter before the
  restore is applied (e.g. `/settings/local-vault` on Android).
- **Restore yields an empty set after filtering** — fall back to the default
  workspace; restore nothing.
- **Schema-drifted / corrupt `state`** — `sanitizeWorkspaceState` returns the
  default workspace; no crash, nothing restored.
- **Two browser tabs of the app on one device** — both write the same row;
  LWW + SERIALIZABLE resolve it; last close wins. Acceptable.
- **Session fetch fails on cold open** — treated as "no session": arm
  capture, restore nothing; the error is narrowed and justified-ignored.
- **Dropped `pagehide`/`beforeunload`** — tolerated; the debounced write is
  the guarantee, the close flush is best-effort.
- **`localStorage` cleared** — new `installationId` → device treated as new →
  cross-device fallback applies.
- **Oversized `state`** — rejected at the API with `E_INVALID_REQUEST`; the
  client treats the write as a (justified-ignored) failure.
- **User-deletion integration point** — the non-cascading FK (D12) means a
  user with `workspace_sessions` rows **cannot be deleted** until those rows
  are removed. `delete_sessions_for_user` **must** be called from the
  user-deletion path. If the current codebase relies on DB `CASCADE` for
  user deletion, that is pre-existing inconsistency with `database.md`; this
  table deliberately does not perpetuate it and supplies the explicit
  cleanup function. **This wiring is required, not optional.**

## Acceptance Criteria

1. With ≥2 panes open, closing the app and reopening the base URL silently
   restores the exact pane set, order, `widthPx`, `visibility`, and
   `activePaneId` — with no prompt, no banner, and no confirmation.
2. The restore is silent end to end: no UI element asks the user to confirm,
   dismiss, or reopen anything.
3. Opening a URL that carries `ws=` never fetches a session and never
   restores; the URL is authoritative.
4. A pane whose `href` is forbidden on the current platform is absent from
   the restored set.
5. A workspace change made between the cold-open fetch starting and
   resolving is **not** clobbered: the silent restore is skipped and the
   user's change is preserved.
6. Capture is debounced: rapid pane operations produce ≲1 write/second; a
   `visibilitychange → hidden` flushes a pending write immediately.
7. Each device restores its **own** last session.
8. A device with no non-trivial session of its own silently restores the
   most recent session from another device; a device that has its own
   non-trivial session restores **its own**, not another device's.
9. Two web tabs of the app on one device produce no error; the last close
   wins.
10. Schema-drifted or corrupt saved state degrades to the default workspace
    with no crash and nothing restored.
11. A `PUT` with extra fields, a non-object `state`, or `state` over the
    size cap is rejected with a typed `E_INVALID_REQUEST`.
12. The feature has no environment flag and is active for all users on merge.

## Test Plan

- **Backend** (`python/tests/test_workspace_sessions.py`, real Postgres):
  upsert creates then updates the same row; `get_most_recent_elsewhere`
  excludes the calling device and orders by `updated_at`; concurrent `PUT`s
  to one row resolve via SERIALIZABLE retry; payload validation rejects bad
  bodies and oversized `state`; `delete_sessions_for_user` removes all rows.
  Assert via API responses, not raw SQL.
- **Client unit:** `getInstallationId` generates once and persists;
  `isColdOpen`, `isNonTrivialSession`, `prepareRestoredState` (sanitize +
  platform filter); the `captureArmed` state machine across all transitions,
  including the silent apply and the baseline-skip when the workspace
  changes mid-fetch; debounce and `visibilitychange`/`pagehide` flush.
- **E2E** (`e2e/`, real stack): close→reopen silently restores the pane set;
  `ws=` deep-link bypass; forbidden-`href` drop; "close before the fetch
  resolves preserves the session"; "a change during the in-flight fetch is
  not clobbered"; cross-device fallback (seed another device's row).

## Implementation Phases

Built in dependency order; landed together (hard cutover — no half-shipped
state behind a flag):

1. Migration + `WorkspaceSession` model.
2. Pydantic schemas; `services/workspace_sessions.py` (SERIALIZABLE upsert,
   getters, `delete_sessions_for_user`); routes; router registration.
3. Wire `delete_sessions_for_user` into the user-deletion path.
4. BFF route `apps/web/src/app/api/me/workspace-session/route.ts`.
5. Client foundation: `deviceId.ts`, `sessionSync.ts`.
6. Capture: `useWorkspaceSession.ts` debounced write + flush + `captureArmed`
   machine, integrated into `WorkspaceStoreProvider`.
7. Restore: cold-open detection, fetch, sanitize + filter, baseline-guarded
   silent `applyRestoredState` in `useWorkspaceSession.ts`.
8. Tests at each layer; E2E last.

## Risks

- **The capture-suspension rule is the one place a bug silently destroys
  user data** (a default workspace overwriting a real saved session). It
  needs dedicated unit tests and an E2E case.
- **`schema.ts` ↔ Pydantic coupling.** The `state` shape is owned by
  `schema.ts`; the backend only checks it is an object with an integer
  `schemaVersion`. Keeping the backend dumb (D9) is what avoids a two-sided
  schema migration on every workspace change — do not "tighten" the backend
  model later without accepting that cost.
- **User-deletion wiring** (Edge Cases) is mandatory; missing it makes
  affected users undeletable.
- **Silent restore surprising the user** — the workspace changes under them
  on a cold open with no announcement. Mitigated three ways: it only happens
  on a cold open (a fresh launch, where seeing the last tabs return is
  expected); the non-trivial gate means a default single-pane session
  restores to the same thing the user would see anyway; and the
  baseline-equality check ensures any action the user takes during the fetch
  is never overwritten. This matches `useReaderResumeState` (D4), which
  resumes a reading position with no prompt and has not needed one.

## Cutover & Cleanup

- Hard cutover: no feature flag, no kill-switch, one code path.
- On production verification, **delete this document**. If any rule here
  proved durable (e.g. "the backend is a dumb per-device blob store"),
  migrate that one line into the appropriate `docs/rules/` file; do not keep
  the doc as a record.
- No code comment, symbol name, or test may reference "workspace-session-
  restore" as an era marker after cutover (`cleanliness.md`).
