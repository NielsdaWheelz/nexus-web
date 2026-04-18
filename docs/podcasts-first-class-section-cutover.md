# podcasts first-class section cutover

this brief defines the hard cutover from a hybrid podcasts discover-plus-subscriptions
surface to a first-class podcast section with semantically honest navigation.

it builds on:

- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/mobile-command-palette.md](./mobile-command-palette.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goal

make `Podcasts` a first-class primary section instead of a discover-owned hybrid
surface.

after this cutover:

- primary navigation shows `Documents`, `Podcasts`, and `Videos` as first-class
  panes instead of filing them under `Discover`
- `Discover` becomes acquisition-only
- `/podcasts` becomes the one podcast home for followed shows and subscription
  operations
- podcast discovery moves to `/discover/podcasts`
- `/podcasts/subscriptions` no longer exists
- libraries remain the only user-facing organization primitive
- `My podcasts` copy no longer appears anywhere in the shipped ui

## scope

this change covers:

- primary navigation structure and active-state rules
- pane route registry entries, titles, subtitles, route ids, and widths
- the discover hub and a dedicated podcast discovery pane
- the podcasts route ownership and copy
- command palette navigation items and recent-destination canonicalization
- focused frontend tests and command-palette backend tests affected by the route
  cutover

this change does not cover:

- library membership semantics
- podcast detail data fetching or podcast episodes api shape
- document or video page content redesign
- adding playlists, queues, folders, or any new organization primitive
- redesigning the global player
- a generic navigation framework, tab framework, or section manifest

## product decision

primary navigation becomes semantically honest.

the primary nav order is:

- `Libraries`
- `Discover`
- `Documents`
- `Podcasts`
- `Videos`
- `Chat`
- `Search`
- `Settings`

`Discover` owns acquisition only.

`Discover` does **not** own:

- `/documents`
- `/podcasts`
- `/videos`
- `/podcasts/:podcastId`

`Documents` and `Videos` remain library-backed media catalogs.

they become first-class nav items because they are stable owned-content surfaces,
not discover surfaces.

`Podcasts` becomes the one podcasts home.

`/podcasts` owns:

- active subscriptions
- unplayed counts
- sync status
- opml import and export
- subscription settings
- unsubscribe
- podcast-level library membership

`/podcasts` does **not** own global discovery.

podcast discovery moves to `/discover/podcasts`.

`/discover/podcasts` owns:

- global podcast search
- discovery results
- subscribe
- subscribe plus add to library
- opening podcast detail for unsubscribed shows

libraries remain the only user-facing organizer, per
[docs/podcast-library-cutover.md](./podcast-library-cutover.md).

the subscriptions surface is operational, not organizational.

`My podcasts` is removed as a label because it hides the real product concept:
subscriptions.

the shipped labels are:

- nav item: `Podcasts`
- `/podcasts` pane title: `Podcasts`
- `/podcasts` subtitle: `Followed shows, sync state, and subscription settings.`
- `/discover/podcasts` pane title: `Discover podcasts`
- `/discover/podcasts` subtitle:
  `Search global feeds, inspect shows, and subscribe.`

## hard cutover rules

- do a hard cutover. do not keep the old hybrid podcasts page alive behind flags,
  fallbacks, or compatibility branches.
- remove `/podcasts/subscriptions` from the pane registry, page tree, tests, and
  command surfaces.
- do not keep `/podcasts/subscriptions` as a redirect, alias, shadow route, or
  hidden compatibility entry.
- remove the inline `My podcasts` link from podcast discovery and podcast detail.
- remove the discover-nav active-state rule that treats `/podcasts*`,
  `/documents`, and `/videos` as children of `Discover`.
- do not keep `Discover` as a mixed launcher for both acquisition and owned
  catalogs.
- do not introduce a generic content-section model, nav manifest, or route
  metadata abstraction for this cutover.
- do not add tabs inside `/podcasts` for `Discover` versus `Following`.
- do not add a second podcasts home.
- do not add a runtime compatibility mapper for old recent destinations.
- if persisted recent destinations include `/podcasts/subscriptions`, rewrite
  them to `/podcasts` in explicit stored data. do not carry legacy routing logic
  in application code.

## implementation rules

- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep the podcasts operational control flow local and linear in the podcasts
  pane body.
- keep the podcast discovery control flow local and linear in one discovery pane
  body.
- keep pane routing explicit in `apps/web/src/lib/panes/paneRouteRegistry.tsx`.
- keep navbar items explicit in `apps/web/src/components/Navbar.tsx`.
- keep command palette navigation items explicit in
  `apps/web/src/components/CommandPalette.tsx`.
- do not add a shared section-definition object, route manifest, or nav builder
  just to avoid a few repeated labels.
- prefer moving existing podcast code into the final route locations over adding
  wrappers around old files.
- delete misleading names from head. final filenames should match final route
  semantics.
- keep existing FastAPI podcast endpoint shapes unless a route-cleanup call site
  requires a direct change.
- keep existing library target picker semantics unchanged.
- keep existing podcast detail route shape unchanged at `/podcasts/:podcastId`.

## route and navigation rules

the final route ownership is:

- `/discover`
- `/discover/podcasts`
- `/documents`
- `/podcasts`
- `/podcasts/:podcastId`
- `/videos`

delete from head:

- `/podcasts/subscriptions`

pane route rules:

- keep `discover` as the acquisition hub route id
- add one explicit route id for `/discover/podcasts`
- keep `documents`
- keep `podcasts`, but change its body to the subscriptions surface
- delete `podcastSubscriptions`
- keep `podcastDetail`
- keep `videos`

navbar rules:

- `Discover` is active only for `/discover` and `/discover/*`
- `Documents` is active only for `/documents`
- `Podcasts` is active for `/podcasts` and `/podcasts/*`
- `Videos` is active only for `/videos`

command palette rules:

- keep `Discover`, `Documents`, `Podcasts`, and `Videos` as explicit navigate
  actions
- add `Discover podcasts` as an explicit navigate action to
  `/discover/podcasts`
- remove any navigate action or recent-route reference that names `My podcasts`
- route recents for `/podcasts` through the existing `podcasts` route id
- remove the dedicated `podcastSubscriptions` recent route id

discover hub rules:

- `Discover` shows acquisition only
- `Discover` does not link to `/documents`, `/podcasts`, or `/videos`
- `Discover` includes an explicit `Discover podcasts` entry
- `Discover` may expose `Upload file` and `Add from URL` actions through the
  existing upload event path
- do not add a new ingestion launcher subsystem for those actions

podcasts pane rules:

- `/podcasts` renders the current subscriptions-management surface
- the pane title is `Podcasts`
- the empty-state copy points to `Discover podcasts`, not `My podcasts`
- podcast rows continue to open `/podcasts/:podcastId`
- opml import, opml export, sort, settings, refresh sync, unsubscribe, and
  library picker remain on `/podcasts`

podcast discovery pane rules:

- `/discover/podcasts` renders the current global podcast discovery surface
- it does not render the subscriptions list
- it does not link to `My podcasts`
- discovery results keep explicit subscribe and subscribe-plus-library actions
- discovery continues to open podcast detail at `/podcasts/:podcastId`

## implementation plan

1. add this cutover doc.
2. add a dedicated podcast discovery route at
   `apps/web/src/app/(authenticated)/discover/podcasts/`.
3. move the current discovery-specific code from
   `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` into that new
   discover route.
4. replace `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` with
   the current subscriptions-management surface.
5. delete `apps/web/src/app/(authenticated)/podcasts/subscriptions/` from head.
6. update `apps/web/src/lib/panes/paneRouteRegistry.tsx` to add the discover
   podcasts route, delete `podcastSubscriptions`, and change the `/podcasts`
   title and subtitle contract.
7. update `apps/web/src/components/Navbar.tsx` so `Documents`, `Podcasts`, and
   `Videos` are first-class nav items and `Discover` is acquisition-only.
8. update `apps/web/src/components/CommandPalette.tsx` to match the new primary
   nav and add `Discover podcasts`.
9. update command-palette recent canonicalization in
   `python/nexus/services/command_palette.py` so stored canonical podcast
   destinations resolve to `/podcasts`.
10. add one explicit data cleanup for persisted recents pointing at
    `/podcasts/subscriptions` so those rows become `/podcasts`.
11. update frontend and backend tests to the final route model and remove legacy
    subscriptions-route assumptions.

## frontend design

### discover

`apps/web/src/app/(authenticated)/discover/DiscoverPaneBody.tsx` becomes a
simple acquisition hub.

it should render only acquisition actions.

the allowed discover entries are:

- `Discover podcasts`
- `Upload file`
- `Add from URL`

do not render owned-content catalogs on the discover hub after cutover.

### discover podcasts

`apps/web/src/app/(authenticated)/discover/podcasts/PodcastDiscoverPaneBody.tsx`
owns:

- podcast query input
- discovery fetch
- discovery error state
- discovery results
- subscribe
- subscribe plus add to library

it does not own subscription list hydration.

### podcasts

`apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` owns:

- subscriptions list fetch
- empty state
- sort
- load more
- library picker state
- settings modal
- refresh sync
- unsubscribe
- opml import and export

it does not own discovery query state or discovery results.

## file plan

required files:

- new doc:
  - `docs/podcasts-first-class-section-cutover.md`
- frontend:
  - `apps/web/src/components/Navbar.tsx`
  - `apps/web/src/components/CommandPalette.tsx`
  - `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  - `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
  - `apps/web/src/__tests__/components/Navbar.test.tsx`
  - `apps/web/src/__tests__/components/PageLayout.test.tsx`
  - `apps/web/src/app/(authenticated)/discover/DiscoverPaneBody.tsx`
  - `apps/web/src/app/(authenticated)/discover/page.tsx`
  - `apps/web/src/app/(authenticated)/discover/page.module.css`
  - `apps/web/src/app/(authenticated)/discover/podcasts/page.tsx`
  - `apps/web/src/app/(authenticated)/discover/podcasts/PodcastDiscoverPaneBody.tsx`
  - `apps/web/src/app/(authenticated)/discover/podcasts/page.module.css`
  - `apps/web/src/app/(authenticated)/podcasts/page.tsx`
  - `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
  - `apps/web/src/app/(authenticated)/podcasts/page.module.css`
  - `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
  - `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`
  - `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- backend:
  - `python/nexus/services/command_palette.py`
  - `python/tests/test_command_palette_recents_integration.py`
  - one explicit data migration or cleanup for persisted
    `command_palette_recents.href = '/podcasts/subscriptions'`

delete from head:

- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/page.module.css`
- tests, screenshots, and copy that still refer to `My podcasts` as a shipped
  surface
- `podcastSubscriptions` route id from pane routing and recents logic

## key decisions

- `Podcasts` is an operational subscriptions section, not a library.
- `Discover podcasts` is a discover route, not a podcasts sub-tab.
- `Documents` and `Videos` move out of the discover cluster so the nav meaning
  stays honest.
- podcast detail remains under `/podcasts/:podcastId` even when opened from
  discovery.
- no redirect or alias is kept for `/podcasts/subscriptions`.
- stored user state may be migrated, but runtime route compatibility is not.

## non-goals

- changing library add or remove behavior
- changing default-library behavior
- redesigning document or video page internals
- adding a new cross-content discover API
- adding a generic top-nav configuration system
- adding bottom navigation, tabs, segmented controls, or a new mobile nav model
- changing podcast detail layout beyond removing stale `My podcasts` links and
  copy

## acceptance criteria

- the sidebar shows `Documents`, `Podcasts`, and `Videos` as first-class nav
  items.
- `Discover` is active only for discover routes.
- `Podcasts` is active for `/podcasts` and `/podcasts/:podcastId`.
- `/podcasts` no longer renders discovery search or discovery results.
- `/podcasts` renders the subscriptions-management surface.
- `/discover/podcasts` renders podcast discovery.
- `/discover/podcasts` does not render the subscriptions list.
- no shipped page, pane title, action, or empty state uses the label
  `My podcasts`.
- `/podcasts/subscriptions` no longer exists in the app route tree or pane
  registry.
- command palette navigate actions match the new primary nav and include
  `Discover podcasts`.
- persisted recent destinations for old podcast subscriptions routes are cleaned
  up without keeping runtime aliases.
- the implementation stays local to the existing navbar, command palette, pane
  registry, discover pages, podcasts pages, and command-palette recent service.
- the implementation does not introduce a nav framework, generic section model,
  route alias layer, or compatibility router.

## regression coverage

required frontend coverage includes:

- component test: navbar renders first-class `Documents`, `Podcasts`, and
  `Videos` items
- component test: `Discover` active state no longer matches `/podcasts`,
  `/documents`, or `/videos`
- pane route test: `/discover/podcasts` resolves to a dedicated route id
- pane route test: `/podcasts/subscriptions` no longer resolves
- podcasts flow test: discovery search and subscribe flow runs from
  `/discover/podcasts`
- podcasts flow test: `/podcasts` renders subscription rows and no discovery form
- podcasts flow test: subscriptions empty state links to `Discover podcasts`
- podcast detail test: detail no longer links to `My podcasts`
- page layout test: page copy matches the new titles and descriptions

required backend coverage includes:

- integration test: command-palette recent canonicalization stores `/podcasts`
  for podcast-home destinations
- integration test: stored `/podcasts/subscriptions` recents are rewritten or
  removed by the explicit cleanup path
- integration test: no recent canonical route id named `podcastSubscriptions`
  remains in supported routing

## validation commands

```bash
cd apps/web && bun run test:browser
cd apps/web && bunx vitest run src/lib/panes/paneRouteRegistry.test.tsx src/__tests__/components/Navbar.test.tsx src/__tests__/components/PageLayout.test.tsx src/app/\(authenticated\)/podcasts/podcasts-flows.test.tsx src/app/\(authenticated\)/podcasts/podcasts-action-menus-cutover.test.tsx
cd python && uv run pytest -q tests/test_command_palette_recents_integration.py
make verify
```
