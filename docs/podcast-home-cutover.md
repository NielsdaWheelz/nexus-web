# podcast home cutover

this brief defines the hard cutover for `/podcasts` under the final shell model
in [docs/browse-add-search-cutover.md](./browse-add-search-cutover.md).

it builds on:

- [docs/browse-add-search-cutover.md](./browse-add-search-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)

## goal

make `/podcasts` the one show-management surface.

after this cutover:

- `/podcasts` lists followed shows, not discovery results
- `/podcasts/subscriptions` no longer exists
- podcast discovery lives in `Browse`, not `Podcasts`
- import lives in `Add`, not `Browse` and not `/podcasts`
- libraries remain the only user-facing organizer

## scope

this change covers:

- the top-level podcasts page contract and pane chrome copy
- removal of `/podcasts/subscriptions`
- ownership split between `Browse`, `Add`, and `/podcasts`
- opml import and export ownership
- frontend and backend tests that assert the final ia

## non-goals

this change does not cover:

- redesigning podcast detail or episode rows
- adding folders, tags, playlists, stations, or podcast-only organizers
- changing library membership semantics
- redesigning the global player or queue
- introducing a generic browse framework, add framework, filter schema, or row
  adapter

## key decisions

`/podcasts` owns subscription management.

the podcasts page owns:

- followed-show search
- followed-show sort
- followed-show filter
- visible library badges
- sync and settings actions
- unsubscribe
- empty-state recovery
- `Export OPML`

the podcasts page does **not** own discovery.

`Browse` owns global acquisition, including podcast search and subscribe flows.

`Add` owns import only.

`Add` may own:

- file upload
- add-from-url
- opml import

`Add` does **not** own podcast discovery search.

`Export OPML` remains on `/podcasts`.

export is management, not creation.

## hard cutover rules

- do a hard cutover. do not keep the old split between `/podcasts` and
  `/podcasts/subscriptions`.
- remove inline discovery from `/podcasts`.
- remove `/podcasts/subscriptions` from routes, links, tests, and recents.
- do not keep podcast discovery in both `Browse` and `Add`.
- do not keep opml import in both `Add` and `/podcasts`.
- do not add redirects, aliases, fallback route ids, or compatibility branches.
- do not force podcast shows through `MediaCatalogPage`.
- do not add a second organizer on top of libraries.

## route and page rules

`/podcasts` remains the only top-level podcast-management route.

its pane chrome is:

- title: `Podcasts`
- subtitle: `Followed shows, library membership, and subscription controls.`

the page header may include:

- one search input
- one filter control
- one sort control
- one `Browse` action
- one overflow menu with `Export OPML`

the page body must not include:

- discovery cards
- discovery results
- episode catalog rows
- inline opml import ui

## browse and add rules

`Browse` owns:

- global podcast search
- subscribe
- subscribe plus add to library
- open detail for unresolved shows

`Add` owns:

- file upload
- add from url
- opml import

do not route podcast search through `Add`.

## implementation rules

- keep the `/podcasts` page control flow local and linear in
  `PodcastsPaneBody.tsx`.
- keep browse acquisition control flow local and linear in the browse surface.
- keep add/import control flow local and linear in the add tray component.
- keep bff routes transport-only, per
  [docs/rules/layers.md](./rules/layers.md).
- keep podcast business logic in `python/nexus/services/podcasts.py`.
- keep branching explicit and exhaustive for page sort, page filter, and row
  actions.
- keep request params shallow and explicit.

## acceptance criteria

- opening `/podcasts` shows followed shows, not discovery results.
- `/podcasts` no longer links to `My podcasts`.
- `/podcasts/subscriptions` no longer exists in the shipped app.
- `Browse` is the only acquisition surface for podcasts.
- `Add` is import-only and does not include podcast discovery search.
- opml import works from `Add`.
- opml export works from `/podcasts`.
- podcast detail continues to own episode browsing and episode actions.
- the implementation does not introduce a second organizer, second show index,
  generic browse framework, generic add framework, or compatibility path.
