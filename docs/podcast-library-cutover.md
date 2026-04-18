# podcast library cutover

this brief defines the hard cutover from podcast categories plus media-only
libraries to mixed libraries that can contain podcast subscriptions and media in
one ordered list.

it builds on:

- [docs/local-markdown-vault.md](./local-markdown-vault.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/database.md](./rules/database.md)
- [docs/rules/concurrency.md](./rules/concurrency.md)
- [docs/rules/errors.md](./rules/errors.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goal

make `library` the single user-facing organization primitive for podcasts,
episodes, and other media.

after this cutover:

- a library can contain podcast subscriptions
- a library can contain media items
- a library shows one mixed ordered list
- podcast categories no longer exist
- podcast subscriptions keep only operational state
- the global player and queue stay separate from libraries

## scope

this change covers:

- the database shape for library contents
- backend library read and write paths
- backend podcast unsubscribe behavior
- frontend library screens
- frontend podcast screens that add or remove podcasts from libraries
- migration from podcast categories to libraries

this change does not cover:

- redesigning the global player
- redesigning transcript reading behavior
- introducing podcast-specific queues, playlists, folders, or library sections
- backward compatibility for the old category model

## product decision

libraries are the only user-facing organizer.

subscriptions keep only subscription state:

- subscribed or unsubscribed
- sync status
- default playback speed
- auto-queue

subscriptions do **not** remain a second organization system.

podcast categories are removed.

default libraries remain media-only provenance and visibility infrastructure.
they do **not** store podcast references.

non-default libraries can contain:

- podcast subscriptions
- media

library views stay unified.

library views do **not** split into `Podcasts` and `Items` sections.

podcast membership means the show itself, not all of its episodes.

adding a podcast to a library does **not** add current or future episodes to
that library.

episodes appear in a library only when the user explicitly adds those episodes.

## hard cutover rules

- do a hard cutover. do not keep the old category system alive behind flags,
  fallbacks, or compatibility branches.
- remove category reads, writes, ui, routes, tests, and schema after the new
  library flow lands.
- do not keep a dual-write period in application code.
- do not add compatibility adapters between old category shapes and new library
  shapes.
- do not add a generic content-membership framework.
- do not add a generic `kind + target_id` polymorphic payload shape.
- do not add a second library list for podcasts.
- do not overload the default-library closure system with podcast references.

## implementation rules

- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep business logic in `python/nexus/services/libraries.py` and
  `python/nexus/services/podcasts.py`.
- keep route handlers thin and explicit.
- keep service control flow local and linear.
- use explicit `SELECT` then `INSERT` or `DELETE`, not `ON CONFLICT`, per
  [docs/rules/database.md](./rules/database.md).
- keep foreign keys concrete. prefer nullable `media_id` and `podcast_id`
  columns over a generic discriminated target id.
- use one mixed ordered library-membership table.
- keep podcast unsubscribe cleanup explicit in application code. do not rely on
  database cascades for library cleanup semantics.
- keep the library ui branch local in the library pane. do not introduce row
  registries, render adapters, or generic entry builders.
- keep list state in urls where the current screens already do so.
- keep search unified through the existing app search and command surfaces.
- keep playback on the existing global player.

## data model

replace `library_media` with a single mixed `library_entries` table.

columns:

- `id uuid primary key`
- `library_id uuid not null`
- `position int not null`
- `created_at timestamptz not null default now()`
- `media_id uuid null`
- `podcast_id uuid null`

required constraints:

- foreign key `library_id -> libraries.id`
- foreign key `media_id -> media.id`
- foreign key `podcast_id -> podcasts.id`
- check exactly one of `media_id` or `podcast_id` is non-null
- unique `(library_id, media_id)`
- unique `(library_id, podcast_id)`
- check `position >= 0`
- index `(library_id, position)`

remove the old `library_media` table entirely at head.

that keeps the runtime schema honest: one concrete mixed-membership table, not a
legacy name carrying new semantics.

default-library closure continues to operate only on media membership.

## migration rules

the migration is explicit and one-way.

1. create `library_entries`.
2. copy existing media rows from `library_media` into `library_entries`.
3. add the mixed-entry constraints and indexes, including the podcast lookup
   index.
4. for each `podcast_subscription_category` owned by a user:
   create one new personal non-default library with the same name and color.
5. add each active subscription in that category to the new library as a
   podcast entry.
6. drop `podcast_subscriptions.unsubscribe_mode`.
7. switch backend library reads and writes to `library_entries`.
8. drop `library_media`.
9. switch frontend library screens to the mixed entry list.
10. remove podcast category routes, service code, ui, and tests.
11. drop `podcast_subscription_categories`, `podcast_subscriptions.category_id`,
   and `podcast_subscriptions.unsubscribe_mode`.

the migration must fail hard on malformed rows.

do not silently skip:

- category rows with missing users
- subscriptions with missing podcasts
- library entries with both targets null
- library entries with both targets populated

those are defects, not product states.

## backend design

### libraries service

`python/nexus/services/libraries.py` owns the mixed library surface.

it should expose explicit operations:

- add media to library
- remove media from library
- add podcast to library
- remove podcast from library
- list library entries
- reorder library entries

do not add a generic `add_entry` or `remove_entry` service unless the final code
is materially smaller and clearer than the explicit pair of operations.

`list_library_entries` returns one ordered list.

each row should include:

- entry id
- position
- created_at
- one explicit target payload:
  - media summary for media entries
  - podcast summary plus subscription state for podcast entries

the returned shape may use an explicit `kind` branch because the response is a
transport shape, but keep that branch local to this read path. do not let it
become a general-purpose internal abstraction.

### podcast service

`python/nexus/services/podcasts.py` keeps subscription operations.

required changes:

- podcast detail must be readable without an active subscription
- subscribe creates or reactivates the subscription only
- unsubscribe updates subscription state and removes that podcast from all
  libraries where the viewer is allowed to remove it

unsubscribe behavior:

- show a destructive confirmation in the ui
- state exactly how many libraries will lose the podcast entry
- remove the podcast entry from all of the viewer's libraries
- remove the podcast entry from shared libraries only if the viewer has admin
  rights in those libraries
- never remove individually saved episodes during unsubscribe

if the podcast remains present in shared libraries where the viewer cannot
remove it, the confirmation and result state must say so explicitly.

do not silently mutate shared libraries outside the viewer's authority.

### default-library closure

`python/nexus/services/default_library_closure.py` remains media-only.

rules:

- podcast entries never create closure edges
- podcast entries never materialize into default libraries
- podcast entries never participate in media visibility rules
- podcast unsubscribe cleanup never touches default-library closure state unless
  it is also removing explicit media entries

## api shape

keep writes explicit.

library writes:

- `POST /api/libraries/{libraryId}/media`
- `DELETE /api/libraries/{libraryId}/media/{mediaId}`
- `POST /api/libraries/{libraryId}/podcasts`
- `DELETE /api/libraries/{libraryId}/podcasts/{podcastId}`
- `PATCH /api/libraries/{libraryId}/entries/reorder`

library reads:

- `GET /api/libraries/{libraryId}/entries`

do not ship a generic `/entries` create or delete endpoint that accepts a mixed
payload.

explicit routes keep validation, auth, and business branches easier to read.

## frontend design

### library pane

`apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx` renders
one mixed ordered list.

rules:

- no sections
- no tabs
- no separate podcast list
- one list item per entry
- podcast row opens `/podcasts/[podcastId]`
- media row opens `/media/[mediaId]`
- show a compact type cue only if needed for scanability
- default ordering is manual list order

the branch between podcast row and media row stays local to this pane.

### podcasts

`apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`,
`apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`,
and
`apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
must change as follows:

- remove category creation, editing, assignment, and reorder ui
- add `Add to library` and `Remove from library` for podcast subscriptions
- keep episode-level add/remove for media entries
- keep subscription settings for speed and auto-queue
- keep unsubscribe as a distinct destructive action
- make podcast detail readable before subscribe
- when unsubscribed from a podcast, remove local podcast-library membership rows
  that the viewer is allowed to remove, then update the detail view accordingly

### subscriptions page

the subscriptions page becomes operational, not organizational.

it should show:

- subscribed shows
- sync state
- unplayed count
- playback speed
- auto-queue
- library membership actions

it should not show:

- category tabs
- category pills
- category editing

## file plan

### docs

- add `docs/podcast-library-cutover.md`

### migrations and models

- add one alembic migration under `migrations/alembic/versions/`
- update `python/nexus/db/models.py`

### backend routes

- `python/nexus/api/routes/libraries.py`
- `python/nexus/api/routes/podcasts.py`

### backend services

- `python/nexus/services/libraries.py`
- `python/nexus/services/podcasts.py`
- `python/nexus/services/default_library_closure.py`
- `python/nexus/services/search.py`
- `python/nexus/auth/permissions.py`

### frontend bff routes

- `apps/web/src/app/api/libraries/[id]/entries/route.ts`
- `apps/web/src/app/api/libraries/[id]/media/route.ts`
- `apps/web/src/app/api/libraries/[id]/media/[mediaId]/route.ts`
- `apps/web/src/app/api/libraries/[id]/podcasts/route.ts`
- `apps/web/src/app/api/libraries/[id]/podcasts/[podcastId]/route.ts`
- `apps/web/src/app/api/libraries/[id]/entries/reorder/route.ts`
- remove category routes under `apps/web/src/app/api/podcasts/categories/`

### frontend panes and shared components

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`

### tests

- `python/tests/test_libraries.py`
- `python/tests/test_podcasts.py`
- `python/tests/test_permissions.py`
- `python/tests/test_search.py`
- `apps/web/src/app/(authenticated)/libraries/[id]/page.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`

## acceptance criteria

- a user can add a podcast subscription to any non-default library.
- a user can add media to any library as before.
- a library detail page shows one mixed ordered list of podcasts and media.
- opening a podcast row from a library opens the podcast pane.
- opening a media row from a library opens the media pane.
- adding a podcast to a library does not add any episodes to that library.
- newly synced episodes do not appear in a library unless explicitly saved there.
- a user can unsubscribe from a podcast and see an explicit destructive
  confirmation that names how many libraries will lose that podcast entry.
- unsubscribing removes podcast entries from libraries the viewer is allowed to
  administer.
- unsubscribing does not remove individually saved episodes.
- podcast detail is viewable before subscribe.
- podcast categories no longer exist in api, services, schema, or ui.
- the default-library closure system remains correct for media.
- the implementation does not introduce a second organizer concept for podcasts.

## non-goals

- keeping old category urls alive
- dual reads from categories and libraries
- dual writes to categories and libraries
- backward compatibility payload branches
- auto-expanding a podcast entry into all of its episodes
- adding a new playlist or folder abstraction
- redesigning queue semantics

## regression coverage

required backend coverage:

- migration test: copy legacy `library_media` rows into `library_entries` and
  remove the legacy table
- migration test: category migration creates personal libraries and podcast
  entries
- service test: add and remove podcast entry from library
- service test: list mixed library entries in stable manual order
- service test: reorder mixed entries
- service test: podcast unsubscribe removes removable podcast-library entries and
  leaves individually saved episodes alone
- service test: unsubscribe does not remove podcast rows from shared libraries
  where the viewer lacks admin rights
- service test: default-library closure still behaves correctly for media-only
  paths
- service test: podcast detail is readable without active subscription

required frontend coverage:

- library page renders one mixed list
- podcast row in library opens podcast pane
- media row in library opens media pane
- podcast detail shows add/remove library actions for the podcast itself
- unsubscribe confirmation describes library removal impact
- subscriptions page no longer shows category ui
- podcast discovery and detail remain usable without category concepts

## validation commands

```bash
uv run pytest -q \
  python/tests/test_libraries.py \
  python/tests/test_podcasts.py \
  python/tests/test_permissions.py \
  python/tests/test_search.py

bunx vitest run \
  "apps/web/src/app/(authenticated)/libraries/[id]/page.test.tsx" \
  "apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx" \
  "apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx"

make verify
```
