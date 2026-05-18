# Workspace Session Restore

## Status

Implementation spec. **Hard cutover** — single code path, no feature flag, no
legacy fallback. This document is temporary scaffolding: delete it once the
feature is verified in production and migrate any durable rule into
`docs/rules/` (see [Cutover & Cleanup](#cutover--cleanup)).

## Summary

When a user reopens the app on a device, restore the set of workspace
panes ("tabs") that were open the last time the app was used **on that
device** — via a non-blocking prompt, not silently. Persist the workspace
to the backend, keyed per device. If the device has no session of its own
(new install, cleared storage), the prompt instead offers the most recent
session from another of the user's devices.

Today the workspace lives only in the URL (`?wsv=4&ws=<base64>` via
`apps/web/src/lib/workspace/urlCodec.ts`). A cold open of the base URL —
which is *every* Android launch and any web launch from a bookmark — drops
all tabs. This feature adds a server-side mirror of the already-serialized
`WorkspaceStateV4` object plus a restore path on cold boot.

## Goals

- A returning device restores its own last workspace, behind a prompt.
- A device with no session of its own can pick up the most recent session
  from another device (cross-device fallback).
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
   authoritative; no session fetch, no prompt.
3. If the entry **is** a cold open, fire `GET /me/workspace-session` for this
   device while the default workspace renders.
4. When the response arrives, decide what to offer (see below). If there is
   something worth restoring, show the **restore prompt**. The workspace is
   **not** changed until the user accepts.

A fetched session is always passed through `sanitizeWorkspaceState`
(`apps/web/src/lib/workspace/schema.ts`) — which version-gates, caps at
`MAX_PANES`, and drops malformed panes — and then through a **platform
filter** that drops panes whose `href` is not permitted on the current
platform (`isAndroidShellRestrictedHref` in
`apps/web/src/lib/androidShell.ts`).

A session is **non-trivial** (worth a prompt) if, after sanitize + filter, it
has more than one pane, or its single pane's `href` is not
`WORKSPACE_DEFAULT_FALLBACK_HREF` (`/libraries`).

What the prompt offers, in priority order:

1. If this device's **own** session is non-trivial → offer the own session.
2. Else if the **most recent session from another device** is non-trivial →
   offer that (cross-device fallback).
3. Else → no prompt.

### The restore prompt

- A **non-blocking** banner rendered by the workspace host. It does not gate
  the app; the user can ignore it and work normally.
- Copy: own session → `Reopen your last N tabs?`; cross-device → `Pick up N
  tabs from another device?`. Actions: **Reopen** and **Dismiss**.
- **Reopen** replaces the current workspace with the restored state
  (`dispatch({ type: "hydrate", state })`), which also writes the restored
  state into the URL and arms capture.
- **Dismiss** keeps the current (default) workspace and arms capture; the
  default state then overwrites the saved session on the next change.
- The prompt **auto-dismisses** on the first user-initiated workspace
  mutation — the user has moved on.
- Dismissal is per-launch only; nothing is persisted. There is no
  "don't ask again."

### Capture suspension on cold open (critical correctness rule)

On a cold open the default workspace renders *before* the session fetch
resolves. If capture ran immediately it would `PUT` the default workspace
and **destroy the saved session before the user could accept the prompt**.

Therefore capture is **suspended on cold open** and armed only when the
restore decision is made. State machine:

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
   │           └──── capture = ARMED ────┘
   ▼
show prompt
   │
   ├── Reopen ──────► workspace replaced ──► capture = ARMED
   ├── Dismiss ─────► capture = ARMED
   └── user mutates workspace ──► prompt auto-dismissed ──► capture = ARMED
```

Once armed, capture stays armed for the rest of the session. While
suspended, both the debounced write and the `visibilitychange`/`pagehide`
flush are no-ops. Consequence: a user who cold-opens and closes again
without acting **preserves** their previous saved session.

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
  of its own, the prompt offers the most recent session from another device.
  This is a read-only feature, not a compatibility fallback.
- **D4 — Non-blocking prompt, never silent restore.** The user always
  confirms. Reopening tabs is a visible, reversible action.
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
  │    ├─ restore:  cold-open detect → GET → sanitize + platform filter → prompt        │
  │    └─ SessionRestorePrompt (non-blocking banner)                                    │
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
  platform filter → prompt → on accept, `hydrate` dispatch.

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

A hook consumed by `WorkspaceStoreProvider` (`store.tsx`). It owns the
`captureArmed` flag and implements the [state machine](#capture-suspension-on-cold-open-critical-correctness-rule):

- **Capture:** on every workspace state change, if `captureArmed` and the
  state differs (`workspaceStatesEqual`) from the last saved state, schedule
  a debounced `putWorkspaceSession`. Register `visibilitychange` and
  `pagehide` listeners that flush immediately with `keepalive`. The initial
  hydrated state is guarded by a `hydratedRef` so it is never written back
  (the pattern in `useReaderResumeState.ts`).
- **Restore:** on mount, if `isColdOpen`, fetch the session; compute the
  prompt offer; expose it to `SessionRestorePrompt`. Arm capture per the
  state machine.

### Restore prompt — `components/workspace/SessionRestorePrompt.tsx`

A non-blocking banner rendered by `WorkspaceHost.tsx`. Shows the offer copy
and **Reopen** / **Dismiss**. **Reopen** calls
`dispatch({ type: "hydrate", state })` with the prepared restored state.
Both actions, and any user-initiated workspace mutation, resolve the prompt
and arm capture.

### Store integration — `store.tsx`

`WorkspaceStoreProvider` calls `useWorkspaceSession(...)`, passing the
current state and a setter for the prompt offer. No reducer actions change;
restore reuses the existing `hydrate` action.

## Final State

When complete, the codebase has — as a single un-flagged code path:

- `workspace_sessions` table + `WorkspaceSession` model.
- `services/workspace_sessions.py`: `get_session`, `get_most_recent_elsewhere`,
  `put_session` (SERIALIZABLE upsert), `delete_sessions_for_user`.
- `routes/workspace_session.py`: `GET` + `PUT /me/workspace-session`,
  registered in `routes/__init__.py`.
- BFF route `apps/web/src/app/api/me/workspace-session/route.ts`.
- `lib/workspace/deviceId.ts`, `sessionSync.ts`, `useWorkspaceSession.ts`.
- `components/workspace/SessionRestorePrompt.tsx` (+ `.module.css`).
- `WorkspaceStoreProvider` captures continuously and restores on cold open.
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
| `apps/web/src/lib/workspace/useWorkspaceSession.ts` | Capture + restore hook; `captureArmed` state machine. |
| `apps/web/src/components/workspace/SessionRestorePrompt.tsx` (+ `.module.css`) | Non-blocking restore banner. |
| `python/tests/test_workspace_sessions.py` | Backend unit + integration tests. |
| `apps/web/src/lib/workspace/sessionSync.test.ts`, `useWorkspaceSession.test.tsx` | Client tests. |
| `e2e/workspace-session-restore.spec.ts` (under `e2e/`) | End-to-end restore flow. |

### Modified

| File | Change |
|------|--------|
| `python/nexus/db/models.py` | Add `WorkspaceSession` model. |
| `python/nexus/api/routes/__init__.py` | Register the new router. |
| `apps/web/src/lib/workspace/store.tsx` | Wire `useWorkspaceSession` into `WorkspaceStoreProvider`. |
| `apps/web/src/components/workspace/WorkspaceHost.tsx` | Render `SessionRestorePrompt`. |
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

- **Cold open, user closes without acting** — capture never armed → no write
  → previous saved session preserved.
- **Stale pane (deleted resource)** — restored; the pane renders its own
  not-found state. No pre-flight liveness check (D8, Non-Goals).
- **Platform-forbidden pane** — dropped by the platform filter before the
  prompt (e.g. `/settings/local-vault` on Android).
- **Restore yields an empty set after filtering** — fall back to the default
  workspace; do not prompt into nothing.
- **Schema-drifted / corrupt `state`** — `sanitizeWorkspaceState` returns the
  default workspace; no crash, no prompt.
- **Two browser tabs of the app on one device** — both write the same row;
  LWW + SERIALIZABLE resolve it; last close wins. Acceptable.
- **Session fetch fails on cold open** — treated as "no session": arm
  capture, no prompt; the error is narrowed and justified-ignored.
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

1. With ≥2 panes open, closing the app and reopening the base URL shows a
   non-blocking prompt `Reopen your last N tabs?`; **Reopen** restores the
   exact pane set, order, `widthPx`, `visibility`, and `activePaneId`.
2. **Dismiss** leaves the default workspace; the saved session is then
   overwritten once the user makes a workspace change.
3. Opening a URL that carries `ws=` never fetches a session and never prompts.
4. A pane whose `href` is forbidden on the current platform is absent from
   the restored set.
5. Cold-opening, seeing the prompt, and closing again **without acting** does
   not change the saved session.
6. Capture is debounced: rapid pane operations produce ≲1 write/second; a
   `visibilitychange → hidden` flushes a pending write immediately.
7. Each device restores its **own** last session.
8. A device with no non-trivial session of its own is offered the most
   recent session from another device (`Pick up N tabs from another
   device?`); a device that has its own non-trivial session is **not**
   offered another device's.
9. Two web tabs of the app on one device produce no error; the last close
   wins.
10. Schema-drifted or corrupt saved state degrades to the default workspace
    with no crash and no prompt.
11. A `PUT` with extra fields, a non-object `state`, or `state` over the
    size cap is rejected with a typed `E_INVALID_REQUEST`.
12. The feature has no environment flag and is active for all users on merge.
13. The first user-initiated workspace mutation auto-dismisses a pending
    prompt.

## Test Plan

- **Backend** (`python/tests/test_workspace_sessions.py`, real Postgres):
  upsert creates then updates the same row; `get_most_recent_elsewhere`
  excludes the calling device and orders by `updated_at`; concurrent `PUT`s
  to one row resolve via SERIALIZABLE retry; payload validation rejects bad
  bodies and oversized `state`; `delete_sessions_for_user` removes all rows.
  Assert via API responses, not raw SQL.
- **Client unit:** `getInstallationId` generates once and persists;
  `isColdOpen`, `isNonTrivialSession`, `prepareRestoredState` (sanitize +
  platform filter); the `captureArmed` state machine across all transitions;
  debounce and `visibilitychange`/`pagehide` flush.
- **E2E** (`e2e/`, real stack): close→reopen restore; **Reopen**/**Dismiss**;
  `ws=` deep-link bypass; forbidden-`href` drop; "close without acting
  preserves session"; cross-device fallback (seed another device's row).

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
7. Restore: cold-open detection, fetch, sanitize + filter,
   `SessionRestorePrompt`, accept/dismiss wiring in `WorkspaceHost.tsx`.
8. Tests at each layer; E2E last.

## Risks

- **The capture-suspension rule is the one place a bug silently destroys
  user data** (a default workspace overwriting a real saved session). It
  needs dedicated unit tests (AC5) and an E2E case.
- **`schema.ts` ↔ Pydantic coupling.** The `state` shape is owned by
  `schema.ts`; the backend only checks it is an object with an integer
  `schemaVersion`. Keeping the backend dumb (D9) is what avoids a two-sided
  schema migration on every workspace change — do not "tighten" the backend
  model later without accepting that cost.
- **User-deletion wiring** (Edge Cases) is mandatory; missing it makes
  affected users undeletable.
- **Prompt fatigue** — a prompt on every cold open. Mitigated by the
  non-trivial gate (no prompt for a single default pane). If it still
  annoys, revisit silent-restore-for-own-session — but that is a follow-up,
  not v1.

## Cutover & Cleanup

- Hard cutover: no feature flag, no kill-switch, one code path.
- On production verification, **delete this document**. If any rule here
  proved durable (e.g. "the backend is a dumb per-device blob store"),
  migrate that one line into the appropriate `docs/rules/` file; do not keep
  the doc as a record.
- No code comment, symbol name, or test may reference "workspace-session-
  restore" as an era marker after cutover (`cleanliness.md`).
