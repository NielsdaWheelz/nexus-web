# command palette recents cutover

this brief defines the hard cutover from device-local command palette recents
to per-user cross-device recent destinations.

it builds on:

- [docs/mobile-command-palette.md](./mobile-command-palette.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/database.md](./rules/database.md)
- [docs/rules/concurrency.md](./rules/concurrency.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goal

make command palette recents follow the user across devices.

after this cutover:

- recent items are per-user, not per-device
- recent items represent reopenable destinations, not static command ids
- what a user opened on desktop can appear in recents on mobile
- the palette stays one global mixed command-and-search surface
- static commands remain searchable but are not the recent model

## scope

this change covers:

- command palette recent-item product semantics
- the database shape for per-user recents
- backend read and write paths for recents
- bff proxy routes for recents
- frontend read path in `CommandPalette`
- frontend write points in workspace open and navigate flows
- removal of local-storage recents code

this change does not cover:

- syncing keybindings
- syncing the pane title cache
- redesigning the command palette layout
- redesigning workspace routing
- a generic user-preferences system
- a generic recent-items framework shared across unrelated features

## product decision

`Recent` means recent destinations the app can reopen on any device.

`Recent` does **not** mean:

- recent static command ids
- recent panes
- recent search queries
- recent transient create flows

the palette continues to show:

- recent destinations
- open panes
- static commands
- backend search results

those remain separate sections with separate semantics.

recent destinations are stable route targets.

the recent model should include:

- top-level authenticated destinations such as `/libraries` and `/search`
- stable resource routes such as `/media/:id`
- stable detail routes such as `/conversations/:id`, `/libraries/:id`, and
  `/podcasts/:id`
- settings routes such as `/settings/reader`

the recent model should not include:

- pane ids
- query-string-only variants of the same destination
- hash-only variants of the same destination
- transient routes such as `/conversations/new`
- upload tray actions
- unsupported or malformed routes

reader resume, transcript offsets, pdf page state, and listening progress stay
in their existing per-user systems.

recent destinations reopen the stable destination.
fine-grained resume remains owned by the existing reader and playback state.

## hard cutover rules

- do a hard cutover. do not keep the local-storage recents path alive behind
  flags, fallbacks, or compatibility branches.
- remove `RECENT_STORAGE_KEY`, `loadRecentIds`, `saveRecentIds`, and the
  static-command recent-id model from `CommandPalette`.
- do not dual-read from local storage and the server.
- do not dual-write local and server recents.
- do not add a migration path that imports old local recent ids.
- do not add a generic `user_settings`, `preferences`, or json blob for this.
- do not add a route-registry-driven recent-destination abstraction.
- do not add adapters, manifests, builders, wrappers, or reusable recent-item
  models unless the final code is materially smaller and clearer than the
  direct explicit code.

## implementation rules

- keep mobile behavior aligned with
  [docs/mobile-command-palette.md](./mobile-command-palette.md):
  one global command palette, no second launcher surface.
- keep bff routes transport-only, per
  [docs/rules/layers.md](./rules/layers.md).
- keep backend business logic in one explicit service module for this feature.
- keep route handlers thin and explicit.
- keep service control flow local and linear.
- use explicit route-family branching for canonicalization. do not introduce a
  generic route classifier.
- use explicit `SELECT` then `INSERT` or `UPDATE`, not `ON CONFLICT`, per
  [docs/rules/database.md](./rules/database.md).
- use the database clock for recency ordering.
- write recents only for real user-driven open and navigate actions.
- do not write recents during hydration, popstate replay, palette open, or pane
  activation.
- keep the frontend write path local to `WorkspaceStoreProvider`.
- keep the frontend read path local to `CommandPalette`.
- prefer a small amount of duplication over shared helper layers.

## data model

add a new `command_palette_recents` table.

columns:

- `id uuid primary key`
- `user_id uuid not null`
- `href text not null`
- `title_snapshot text null`
- `created_at timestamptz not null default now()`
- `last_used_at timestamptz not null default now()`

required constraints:

- foreign key `user_id -> users.id`
- unique `(user_id, href)`

required indexes:

- index `(user_id, last_used_at desc, id desc)`

do not store:

- pane ids
- command ids
- json payloads
- route params broken out into separate columns

keep the table literal and concrete.

## canonical destination rules

canonicalization is explicit and local.

the backend write path must normalize each candidate `href` with an ordered
explicit branch chain.

required rules:

1. reject any non-app route.
2. strip query strings and hashes.
3. keep stable top-level app routes as-is.
4. keep stable settings sub-routes as-is.
5. collapse stable resource families to their path form:
   - `/media/:id`
   - `/conversations/:id`
   - `/libraries/:id`
   - `/podcasts/:id`
6. reject transient create routes such as `/conversations/new`.
7. reject unsupported routes.

examples:

- `/media/abc?fragment=f1&highlight=h1` -> `/media/abc`
- `/media/abc?t_start_ms=1200` -> `/media/abc`
- `/conversations/xyz?message=7` -> `/conversations/xyz`
- `/search?q=test` -> `/search`
- `/conversations/new?quote=123` -> reject

the branch chain should stay inline in the service code.
do not extract a route-normalization framework.

## backend design

### route surface

add one per-user endpoint family:

- `GET /me/command-palette-recents`
- `POST /me/command-palette-recents`

`GET` returns the current viewer's recent destinations ordered by
`last_used_at desc, id desc`.

`POST` records one destination for the current viewer.

request body:

- `href string required`
- `title_snapshot string optional`

response row shape:

- `href`
- `title_snapshot`
- `last_used_at`

unsupported or transient routes return `400` and create no row.

do not add:

- `PATCH`
- `DELETE`
- bulk record APIs
- generic recent-item endpoints shared with other features

### service ownership

add one explicit service module:

- `python/nexus/services/command_palette.py`

it should expose two operations:

- list recents for viewer
- record recent for viewer

do not add a generic repository layer.
do not add a reusable preference service.

### write behavior

`record recent for viewer` must:

1. canonicalize the incoming `href`
2. reject unsupported or transient routes with `400`
3. trim and normalize `title_snapshot` if present
4. `SELECT` an existing row for `(user_id, href)`
5. if found, update `last_used_at = now()` and refresh `title_snapshot` when a
   non-empty title is provided
6. if not found, insert a new row
7. delete rows beyond the fixed limit for that user

the fixed limit is `8`.

the trim step should delete rows ordered after the first 8 by
`last_used_at desc, id desc`.

all of that should happen in one explicit transaction.

### read behavior

`list recents for viewer` should:

- return at most 8 rows
- order by `last_used_at desc, id desc`
- return only rows for the authenticated viewer

do not join unrelated tables just to decorate titles.

`title_snapshot` is a snapshot, not a live derived projection.

## frontend design

### read path

`apps/web/src/components/CommandPalette.tsx` should:

- fetch `/api/me/command-palette-recents` when the palette opens
- store the returned rows in local component state
- render those rows in the `Recent` section when there is no query
- execute recent rows by reopening their `href`

remove the local-storage recent-id logic entirely.

keep static commands in their existing sections.
keep pane actions in their existing section.
keep backend search results in their existing section.

### write path

`apps/web/src/lib/workspace/store.tsx` owns recent-destination writes.

required write points:

- the existing open-pane event path
- the explicit `openPane(...)` path
- the explicit `navigatePane(...)` path

required non-write points:

- `activatePane(...)`
- url hydration on mount
- `popstate`
- pane close

write requests should be fire-and-forget and must not block navigation.

the client should post:

- canonical app `href` candidate
- optional `title_snapshot`

### title snapshot rules

the frontend may send `title_snapshot` from two places:

- the open detail when a `titleHint` already exists
- `publishPaneTitle(...)` after a pane resolves a stable runtime title

that keeps cross-device recent labels readable without introducing a metadata
fetch layer.

do not add a separate recent-title reconciliation subsystem.

### bff route

add:

- `apps/web/src/app/api/me/command-palette-recents/route.ts`

it should proxy directly to FastAPI and contain no business logic.

## file plan

required files:

- new doc:
  - `docs/command-palette-recents-cutover.md`
- frontend:
  - `apps/web/src/components/CommandPalette.tsx`
  - `apps/web/src/lib/workspace/store.tsx`
  - `apps/web/src/app/api/me/command-palette-recents/route.ts`
- backend:
  - `python/nexus/api/routes/me.py`
  - `python/nexus/services/command_palette.py`
  - `python/nexus/db/models.py`
  - one alembic migration adding `command_palette_recents`

delete from head:

- local-storage recent-id code in `CommandPalette`
- tests that assert local-storage recents behavior

## non-goals

- syncing keyboard shortcuts
- syncing upload tray actions
- syncing recent search queries
- tracking every pane mutation as history
- exact reconstruction of query-param state across devices
- adding a generic recent-items platform for the whole app

## acceptance criteria

- on desktop and mobile, `Recent` shows the same recent destinations for the
  same authenticated user.
- a destination opened on desktop can appear in `Recent` on mobile after the
  server write completes.
- `Recent` no longer depends on browser `localStorage`.
- `Recent` no longer stores or renders static command ids.
- static commands remain searchable and executable in their existing sections.
- pane actions remain visible and local to the current workspace session.
- search results remain search-backed and are not themselves stored as palette
  recents.
- opening `/media/:id` with reader-specific query params records `/media/:id`
  as the recent destination.
- reopening a recent media destination uses the existing reader resume state,
  not the discarded query params.
- transient routes such as `/conversations/new` are not recorded.
- palette open, pane activation, initial url hydration, and popstate do not
  write recents.
- recent rows are ordered by `last_used_at desc, id desc`.
- the per-user recent list is capped at 8 rows.
- the implementation uses one explicit per-user recent table and one explicit
  endpoint family, not a generic settings blob.
- the implementation stays local to `CommandPalette`, `WorkspaceStoreProvider`,
  one bff route, and one backend service module.

## regression coverage

required frontend coverage includes:

- component test: palette reads recent destinations from the authenticated api
  path and renders them in `Recent`
- component test: static commands still render when no query is present
- component test: executing a recent destination reopens its `href`
- component test: `Recent` does not read or write command-palette local storage
- component test: open-pane and navigate paths post recents
- component test: activate-pane does not post recents

required backend coverage includes:

- integration test: `GET /me/command-palette-recents` returns only the current
  viewer's rows in descending recency order
- integration test: `POST /me/command-palette-recents` inserts a new row for a
  supported route
- integration test: posting the same canonical route updates `last_used_at`
  instead of creating a second row
- integration test: posting more than 8 supported routes trims older rows
- integration test: query-param variants of the same destination collapse to
  one canonical row
- integration test: transient routes such as `/conversations/new` are rejected
  by the write path and do not create rows

## validation commands

```bash
make test-front-browser
make test-back-integration
make verify
```
