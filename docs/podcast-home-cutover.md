# podcast home cutover

this brief defines the hard cutover from a split podcast surface to one
explicit podcast home plus one explicit global add or import flow.

it builds on:

- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goals

make `/podcasts` the one user-facing show-management surface.

after this cutover:

- `/podcasts` lists followed shows, not episode catalog rows
- `/podcasts/subscriptions` no longer exists
- podcast discovery no longer lives inline on the podcasts page
- podcast import lives in the global `Add` flow
- podcast detail remains the show-specific episode surface
- libraries remain the only user-facing organizer

## scope

this change covers:

- the top-level podcasts page contract and pane chrome copy
- removal of the dedicated subscriptions page and route
- the add dialog contract for podcast search and opml import
- command palette and navbar add entrypoints
- subscription-list api shape needed by the new podcasts page
- frontend and backend tests that assert the new ia

## non-goals

this change does not cover:

- redesigning podcast detail or episode row behavior
- adding podcast folders, tags, categories, playlists, stations, or podcast-only
  queues
- changing library membership semantics
- redesigning the global player or queue
- adding batch multi-select editing in this cutover
- introducing a generic add-surface framework, generic browse-manage framework,
  or generic filtering dsl

## key decisions

`/podcasts` is the single show-management surface.

there is no second `My podcasts` page after cutover.

the podcasts page owns:

- subscribed-show search
- subscribed-show sort
- subscribed-show filter
- visible library membership badges
- inline show-management actions
- the empty state and `Add` entrypoint
- `Export OPML` in page overflow

the podcasts page does **not** own discovery.

discovery and import move into the global `Add` flow.

the global add dialog gets three explicit modes:

- `Content`
- `Podcast`
- `OPML`

those modes stay local to the dialog component.

do not build a generic tab system, launcher system, or import framework for
this.

`Content` keeps the existing file and url ingestion flow.

`Podcast` adds podcast search plus subscribe.

`OPML` adds subscription import.

`Export OPML` does not live in `Add`.

export is management, not creation.

it belongs on the podcasts page overflow menu.

podcast detail keeps ownership of episode browsing and episode actions.

the top-level podcasts page is a show index, not a second episode index.

libraries remain the only organizer.

do not add folders, tags, sections, or categories to compensate for poor page
ia.

## hard cutover rules

- do a hard cutover. do not keep the old split between `/podcasts` and
  `/podcasts/subscriptions`.
- remove the inline discovery card from `/podcasts`.
- remove the `/podcasts/subscriptions` route, page, component, stylesheet,
  route-registry entry, tests, and links.
- do not add redirects, aliases, compatibility route ids, or legacy fallback
  copy for `/podcasts/subscriptions`.
- do not keep `Import OPML` in both the add dialog and the podcasts page.
- do not keep discovery in both the add dialog and the podcasts page.
- do not force podcast shows through `MediaCatalogPage`.
- do not add a second organizer on top of libraries.
- do not add a generic filter schema, generic sorter schema, generic row
  adapter, or generic add-mode registry.

## implementation rules

- keep `apps/web/src/app/(authenticated)/podcasts/page.tsx` as a thin wrapper.
- keep the new podcasts-page control flow local and linear in
  `PodcastsPaneBody.tsx`.
- keep podcast-detail behavior local to the existing detail files.
- keep bff routes transport-only, per
  [docs/rules/layers.md](./rules/layers.md).
- keep business logic in `python/nexus/services/podcasts.py`.
- keep the add-dialog control flow local to the dialog component.
- if the add dialog is broadened beyond ingestion, rename the component and
  event names to match the new product meaning. do not keep ingestion-only
  names once the dialog owns podcast search and opml import.
- keep branching explicit and exhaustive for dialog mode, page filter, and page
  sort.
- keep request params shallow and explicit. do not add nested filter objects or
  generic query payloads.

## route and page rules

`podcasts` in `apps/web/src/lib/panes/paneRouteRegistry.tsx` remains the only
top-level podcast-management route.

its pane chrome must change to describe the new contract:

- title: `Podcasts`
- subtitle: `Followed shows, library membership, and subscription controls.`

remove `podcastSubscriptions` from `paneRouteRegistry.tsx`.

remove route references to `/podcasts/subscriptions` from:

- podcast-page buttons and links
- command palette navigation
- recent-item icon handling
- any test fixtures that still open that route

the podcasts page body shows one flat subscribed-show list.

do not split the page into separate `Shows` and `Episodes` sections.

the page header row must include:

- one search input
- one filter control
- one sort control
- one `Add` action
- one overflow menu with `Export OPML`

the page body must not include:

- discovery cards
- episode catalog rows
- inline opml import ui

## podcasts page contract

each show row must show:

- artwork
- title
- author when present
- latest episode recency
- unplayed count when greater than zero
- visible library badges

each show row must expose:

- open detail
- library picker
- refresh sync
- settings
- unsubscribe

the page must support these sorts:

- `recent_episode`
- `unplayed_count`
- `alpha`

the page must support these filters:

- `all`
- `has_new`
- `not_in_library`

the page may also scope by one selected library.

that library scope is separate from the main filter enum.

the page search is a simple text query over followed shows.

the page must support:

- zero-subscription empty state with `Add`
- non-empty list
- empty filtered state with clear recovery

## add or import contract

the global add dialog is the only creation and import entrypoint for podcasts.

it must expose three explicit modes:

- `Content`
- `Podcast`
- `OPML`

`Content` keeps the existing file and url queue behavior.

`Podcast` must support:

- one search input backed by `/api/podcasts/discover`
- discovery result rows
- direct `Subscribe`
- adjacent library targeting through the existing library picker contract
- open-in-app behavior after subscribe when the discovered result resolves to a
  local podcast id

`OPML` must support:

- one file picker
- one submit action
- import summary output
- explicit error output

`OPML` mode does not need drag-and-drop in this cutover.

keep it explicit and local.

## api contract

keep these existing routes:

- `GET /api/podcasts/discover`
- `POST /api/podcasts/subscriptions`
- `POST /api/podcasts/import/opml`
- `GET /api/podcasts/export/opml`

do not add new podcast discovery or import endpoints for this cutover.

extend the subscription-list read path only where the new podcasts page needs
it.

`GET /api/podcasts/subscriptions` must accept these shallow query params:

- `limit`
- `offset`
- `sort`
- `q`
- `filter`
- `library_id`

`filter` is one explicit enum:

- `all`
- `has_new`
- `not_in_library`

do not add:

- filter arrays
- nested query objects
- generic search payloads
- generic `state` bags

each subscription-list row must include:

- current podcast summary
- current subscription status fields already returned today
- `unplayed_count`
- `latest_episode_published_at`
- visible non-default libraries for badge rendering

the route remains active-subscriptions only.

do not add a second show-index endpoint.

do not add a second discovery endpoint for the add dialog.

## files

primary frontend files to edit:

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/page.module.css`
- `apps/web/src/components/Navbar.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/IngestionTray.tsx` if kept
- `apps/web/src/components/IngestionTray.module.css` if kept

frontend files to remove:

- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.module.css`

frontend bff files to edit or verify:

- `apps/web/src/app/api/podcasts/subscriptions/route.ts`
- `apps/web/src/app/api/podcasts/discover/route.ts`
- `apps/web/src/app/api/podcasts/import/opml/route.ts`
- `apps/web/src/app/api/podcasts/export/opml/route.ts`

backend files to edit:

- `python/nexus/api/routes/podcasts.py`
- `python/nexus/schemas/podcast.py`
- `python/nexus/services/podcasts.py`

tests to update:

- `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`
- `apps/web/src/app/api/podcasts/podcasts-routes.test.ts`
- `python/tests/test_podcasts.py`

## implementation plan

1. change the route contract so `/podcasts` is the one subscribed-show page and
   remove `podcastSubscriptions` from the pane registry.
2. delete the dedicated subscriptions page files and remove all links to that
   route.
3. rewrite `PodcastsPaneBody.tsx` so it renders the subscribed-show page
   contract instead of discovery plus `MediaCatalogPage`.
4. extend the subscription-list backend read path with the exact fields and
   shallow query params the new page needs.
5. extend the add dialog with one explicit local mode branch for `Content`,
   `Podcast`, and `OPML`.
6. rename the add dialog component and open event if the old ingestion-only name
   becomes misleading.
7. move podcast discovery and opml import into that dialog.
8. add `Export OPML` to the podcasts page overflow menu.
9. update command palette and navbar add entrypoints to open the new dialog.
10. update tests and remove assertions that depend on `/podcasts/subscriptions`
    or inline discovery on `/podcasts`.

## cases to cover

- zero subscriptions
- many subscriptions
- subscribed-show search with results
- subscribed-show search with no results
- `has_new` filter
- `not_in_library` filter
- one selected library scope
- each supported sort
- row library membership changes
- row unsubscribe
- row sync refresh
- podcasts-page `Export OPML`
- add dialog `Podcast` mode subscribe
- add dialog `Podcast` mode subscribe plus library
- add dialog `OPML` mode import success
- add dialog `OPML` mode import failure

## acceptance criteria

- opening `/podcasts` shows a followed-show index, not episode catalog rows.
- `/podcasts` no longer shows the discovery card.
- `/podcasts` no longer links to a separate `My podcasts` page.
- `/podcasts/subscriptions` no longer exists in the shipped app.
- `podcastSubscriptions` no longer exists in the pane registry.
- the podcasts page supports search, filter, sort, and one `Add` entrypoint.
- the podcasts page shows visible library badges on show rows.
- the podcasts page shows latest-episode recency and unplayed count on show
  rows.
- the podcasts page exposes inline management actions for each show.
- the global add dialog includes explicit `Podcast` and `OPML` modes.
- podcast discovery works from the add dialog.
- opml import works from the add dialog.
- opml export works from the podcasts page overflow.
- podcast detail continues to own episode browsing and episode actions.
- the implementation does not introduce a second organizer, second show index,
  generic add framework, generic filter dsl, or legacy compatibility path.

## regression coverage

required frontend coverage includes:

- pane registry test: `podcastSubscriptions` is removed and `podcasts` uses the
  new subtitle
- podcasts page test: subscribed-show rows render with the new top-level
  controls
- podcasts page test: discovery no longer renders inline
- podcasts page test: `Export OPML` is available from page overflow
- add dialog test: `Podcast` mode searches and subscribes
- add dialog test: `OPML` mode posts the selected file and renders summary

required backend coverage includes:

- subscriptions list test: `q`, `filter`, `library_id`, and `sort` behave
  correctly
- subscriptions list test: rows include latest-episode recency and visible
  library data
- opml import test: existing import behavior remains intact
- export opml test: export behavior remains intact
