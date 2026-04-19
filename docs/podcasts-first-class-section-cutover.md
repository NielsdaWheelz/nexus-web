# podcasts first-class section cutover

this brief defines the hard cutover that keeps `Podcasts` as a first-class
section inside the final shell described in
[docs/browse-add-search-cutover.md](./browse-add-search-cutover.md).

it builds on:

- [docs/browse-add-search-cutover.md](./browse-add-search-cutover.md)
- [docs/podcast-home-cutover.md](./podcast-home-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)

## goal

make `Podcasts` a first-class management section without keeping legacy
discover-owned or media-catalog-owned navigation.

after this cutover:

- primary navigation is `Libraries`, `Browse`, `Podcasts`, `Chats`, `Search`,
  `Settings`, plus global `Add`
- `Browse` owns acquisition
- `/podcasts` owns followed-show management
- `Search` stays internal-only
- `/discover`, `/documents`, and `/videos` no longer exist in head
- `My podcasts` and singular `Chat` no longer appear in shipped chrome

## scope

this change covers:

- primary navigation structure and labels
- pane route registry entries, titles, subtitles, and route ids
- route ownership between `Browse`, `Podcasts`, and `Search`
- removal of legacy top-level discover and media-catalog routes
- focused tests that assert the final shell

## non-goals

this change does not cover:

- browse implementation details
- add tray implementation details
- library membership semantics
- podcast detail data fetching or episode api shape
- redesigning document or video readers
- adding playlists, queues, folders, tabs, or any new organization primitive
- introducing a generic nav manifest, route metadata layer, or section builder

## product decision

primary navigation becomes:

- `Libraries`
- `Browse`
- `Podcasts`
- `Chats`
- `Search`
- `Settings`
- global action: `Add`

`Browse` owns acquisition only.

`Browse` does **not** own:

- organization
- subscription management
- import
- internal workspace retrieval

`Podcasts` remains the one podcasts home.

`/podcasts` owns:

- active subscriptions
- unplayed counts
- sync status
- library membership
- settings
- unsubscribe
- export opml

`/podcasts` does **not** own global discovery.

`Search` remains separate.

it owns internal retrieval across content already in nexus.

`Add` remains separate.

it owns import and direct ingestion only.

`Documents` and `Videos` are removed as top-level sections.

their owned-content behavior belongs under `Libraries`; their acquisition
behavior belongs under `Browse`.

## hard cutover rules

- do a hard cutover. do not keep `/discover`, `/documents`, or `/videos` as
  routes, redirects, aliases, or hidden compatibility entries.
- remove `/podcasts/subscriptions` from head.
- do not keep podcast discovery in `Podcasts`.
- do not keep import ui in `Browse`.
- do not add tabs inside `/podcasts` for `Browse` versus `Following`.
- do not add a runtime compatibility mapper for removed routes.
- do not add a shared section-definition object, route manifest, or nav builder.

## implementation rules

- keep pane routing explicit in `apps/web/src/lib/panes/paneRouteRegistry.tsx`.
- keep navbar items explicit in `apps/web/src/components/Navbar.tsx`.
- keep command palette items explicit where they exist.
- prefer direct route deletion over compatibility logic.
- keep naming semantically honest in labels, route ids, titles, and subtitles.
- keep control flow local and linear inside each surface.

## route and navigation rules

the final route ownership is:

- `/browse`
- `/libraries`
- `/libraries/:id`
- `/media/:id`
- `/podcasts`
- `/podcasts/:podcastId`
- `/conversations`
- `/conversations/new`
- `/conversations/:id`
- `/search`
- `/settings`
- `/settings/*`

delete from head:

- `/discover`
- `/discover/podcasts`
- `/documents`
- `/videos`
- `/podcasts/subscriptions`

pane route rules:

- add one explicit `browse` route id for `/browse`
- keep `podcasts` and `podcastDetail`
- keep `search` separate
- reject removed routes explicitly

navbar rules:

- `Browse` is active only for `/browse`
- `Podcasts` is active for `/podcasts` and `/podcasts/*`
- `Chats` is active for `/conversations` and `/conversations/*`
- `Search` is active only for `/search`
- `Settings` is active for `/settings` and `/settings/*`

## acceptance criteria

- the shipped nav labels and order are `Libraries`, `Browse`, `Podcasts`,
  `Chats`, `Search`, `Settings`, `Add`
- `Discover`, `Documents`, `Videos`, and singular `Chat` do not appear in the
  shipped shell
- `/browse` resolves as a first-class route
- `/discover`, `/documents`, `/videos`, and `/podcasts/subscriptions` are
  rejected
- `/search` remains a separate internal route
- `/podcasts` remains the subscription-management surface
- the implementation does not introduce compatibility routing, route aliases,
  nav manifests, or section builders
