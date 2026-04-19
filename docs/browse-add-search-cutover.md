# browse, add, and top-level navigation cutover

this brief defines the hard cutover from the current mixed `Discover` plus
`Documents` plus `Videos` navbar model to one acquisition surface, one import
surface, one internal-search surface, and one explicit owned-content
organization model.

this document is authoritative for browse, add, search, and top-level
navigation ownership.

if older docs conflict on whether discovery belongs in `Discover`, `Add`, or a
content-type page, follow this document.

it builds on:

- [docs/podcast-home-cutover.md](./podcast-home-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/podcasts-first-class-section-cutover.md](./podcasts-first-class-section-cutover.md)
- [docs/podcast-show-surface-cutover.md](./podcast-show-surface-cutover.md)
- [docs/mobile-command-palette.md](./mobile-command-palette.md)
- [docs/command-palette-recents-cutover.md](./command-palette-recents-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goal

make the product model semantically honest and durable.

after this cutover:

- `Browse` is the one acquisition surface
- `Add` is the one import surface
- `Search` is the one internal retrieval surface
- `Libraries` remain the only user-facing organizer
- `Podcasts` remain the one subscriptions-management surface
- `Chats` is the shipped label for conversations
- `Documents` and `Videos` are no longer top-level product areas

## scope

this change covers:

- top-level navigation labels, order, and active-state rules
- pane route ids, route ownership, titles, and subtitles
- the browse route and browse result contract
- the add tray contract and naming
- command palette navigation and create actions
- command palette recents canonicalization and cleanup
- deletion of the top-level documents and videos surfaces
- deletion of the current launcher-style discover surface
- the podcasts page actions and empty-state links affected by the ownership split

this change does not cover:

- redesigning podcast detail or episode-pane ownership
- redesigning the global player
- redesigning library entry rows beyond what is required by the removed routes
- introducing saved views, pinned views, tags, folders, playlists, or a second
  organizer
- broadening `/search` into a unified browse-plus-search surface
- a generic browse framework, search framework, or navigation framework

## non-goals

- do not preserve the current `Discover` page as a launcher
- do not preserve `Documents` or `Videos` as top-level routes
- do not keep both browse and add as discovery entrypoints
- do not make `/search` responsible for external acquisition results
- do not add a second browse surface under `Podcasts`
- do not add a route alias, redirect, compatibility map, or legacy fallback for
  removed routes

## product decision

the final product model is:

- `Browse` finds new things not yet in nexus
- `Add` imports a known file, url, or opml payload into nexus
- `Search` finds things already in nexus
- `Libraries` organize owned content
- `Podcasts` manage followed shows and subscription operations
- `Chats` manages conversations

that means:

- browse is query-first and acquisition-only
- add is write-first and import-only
- search is read-first and internal-only
- libraries stay as the only organizer, per
  [docs/podcast-library-cutover.md](./podcast-library-cutover.md)

`Documents` and `Videos` are not peer product concepts.

they are library-owned content types, not first-class app sections.

they should not survive as peer nav items just because they currently have thin
wrapper pages.

## key decisions

- do a real rename from `Discover` to `Browse`
- use one top-level browse route: `/browse`
- delete `/discover` from head instead of relabeling it in place
- keep `/search` as a separate route and separate capability
- remove podcast discovery from the add tray
- make the add tray import-only
- delete the top-level `/documents` and `/videos` routes
- keep `/podcasts` and `/podcasts/:podcastId`
- keep `/conversations` route shape, but ship the label `Chats`
- do not reuse the internal `/search` result shape for browse
- do not reuse `MediaCatalogPage` for browse
- do not add a generic browse result adapter, source registry, section manifest,
  or helper framework

## target behavior

### browse

`/browse` is the only acquisition surface.

it owns:

- one global query input
- one explicit result-type filter row
- one result list
- one pagination path
- global acquisition results across:
  - podcasts
  - podcast episodes
  - videos
  - documents

it does not own:

- file upload
- url paste import ui
- opml import ui
- owned-library listing
- transcript, annotation, message, or fragment search

the shipped browse type filters are:

- `All`
- `Podcasts`
- `Episodes`
- `Videos`
- `Documents`

keep the filter count capped at these five.

do not add a wider filter bar or a second row of filter groups in this cutover.

the browse result list stays explicit by row type:

- podcast show rows open `/podcasts/:podcastId` when local, or call the existing
  podcast-specific ensure path before opening
- podcast show rows keep explicit `Subscribe` and `Subscribe + add to library`
  actions
- podcast episode rows use explicit add actions and do not create local rows
  until the user explicitly adds them
- video rows use explicit add actions and do not create local rows until the
  user explicitly adds them
- document rows use explicit add actions and do not create local rows until the
  user explicitly adds them
- if a browse result is already local, the row may open the local media or
  podcast surface directly

keep that control flow local in the browse pane.

do not introduce a generic `ensure content-like thing` capability.

the existing podcast-specific ensure flow is sufficient and remains
podcast-specific.

### add

the global add tray is the only import surface.

it owns:

- file upload
- add from url
- opml import

it does not own:

- global podcast search
- global video search
- global document search
- browse results

the final add tray modes are:

- `Content`
- `OPML`

delete the current `Podcast` mode from head.

`Content` may continue to accept article, video, and feed urls as direct ingest
targets.

that is still import, not browse.

`Add` remains a global action, not a route.

### search

`/search` stays internal-only.

it owns:

- search across existing media
- search across transcript chunks
- search across annotations
- search across fragments
- search across chats and messages

it does not own:

- external acquisition
- podcast feed discovery
- document discovery
- video discovery

keep the current internal search contract local to `/search`.

do not fold browse into it.

### podcasts

`/podcasts` remains the one subscriptions-management surface.

it owns:

- followed shows
- show search
- show sort
- show filters
- sync state
- show settings
- unsubscribe
- library membership
- export opml

it does not own:

- discovery lists
- browse results
- inline import ui

the primary page action on `/podcasts` becomes `Browse`.

that action opens `/browse?type=podcasts`.

keep `Export OPML` on `/podcasts` because export is management, not creation.

empty-state copy on `/podcasts` points to `Browse`, not `Add`.

### libraries

`Libraries` remains the only organizer.

do not add new top-level sections to compensate for removing `Documents` and
`Videos`.

if a library-owned type filter is needed, keep it explicit and local to the
library surfaces.

do not create a saved-views system, pinning system, or generic filtered-view
framework in this cutover.

## final state

### top-level nav

the final desktop nav order is:

- `Libraries`
- `Browse`
- `Podcasts`
- `Chats`
- `Search`
- `Settings`

the final global action is:

- `Add`

delete from top-level nav:

- `Discover`
- `Documents`
- `Videos`
- singular `Chat`

### route ownership

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
- `/settings/billing`
- `/settings/reader`
- `/settings/keys`
- `/settings/local-vault`
- `/settings/identities`
- `/settings/keybindings`

delete from head:

- `/discover`
- `/documents`
- `/videos`

keep deleted:

- `/podcasts/subscriptions`
- `/discover/podcasts`

there is one browse route.

do not add:

- `/browse/podcasts`
- `/browse/videos`
- `/browse/documents`
- `/browse/episodes`

if browse needs shareable state, keep it in shallow query params on `/browse`.

the final browse query params are:

- `q`
- `type`
- `cursor`

do not introduce a filter dsl, nested payload, or multi-param browsing grammar.

## hard cutover rules

- do a hard cutover. do not keep `Discover` alive behind relabeling, redirects,
  aliases, or fallback routes
- do a hard cutover. delete `/documents` and `/videos` from the app route tree,
  pane routing, command surfaces, and tests
- do a hard cutover. delete podcast discovery from the add tray
- do not keep both browse and add as discovery entrypoints
- do not keep import shortcuts on the browse page
- do not keep browse launcher cards once `/browse` is a real search surface
- do not keep `Documents` or `Videos` navigate actions in the command palette
- do not keep `Discover` or `Chat` copy anywhere in shipped chrome after the
  rename
- do not keep `/discover`, `/documents`, or `/videos` in command-palette
  recents via runtime mapping logic
- if old recents exist in stored data, do one explicit cleanup and then delete
  the old paths from head
- do not reuse `/api/search` for browse
- do not reuse `MediaCatalogPage` for browse
- do not add a generic browse result model, generic acquisition model, generic
  source abstraction, or generic row renderer registry

## implementation rules

- keep pane routing explicit in
  `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- keep navbar items explicit in `apps/web/src/components/Navbar.tsx`
- keep command palette actions explicit in
  `apps/web/src/components/CommandPalette.tsx`
- keep browse page control flow local and linear in `BrowsePaneBody.tsx`
- keep add tray control flow local and linear in `AddContentTray.tsx`
- keep browse row branching explicit in the browse pane body
- keep request params shallow and explicit
- keep browse response branching explicit and local to the browse capability
- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md)
- keep browse business logic in one explicit backend service
- prefer inlining one-use browse row branches, object shapes, and constants
- do not add helper layers just to share small bits of row rendering
- small duplication between podcast, episode, video, and document browse rows is
  acceptable if it keeps the code easier to scan

## browse api contract

add one explicit browse route.

frontend:

- `GET /api/browse`

backend:

- `GET /browse`

accepted query params:

- `q`
- `type`
- `limit`
- `cursor`

the shipped `type` values are:

- `all`
- `podcasts`
- `podcast_episodes`
- `videos`
- `documents`

the browse response stays shallow and explicit.

each row must include one explicit type branch.

do not try to force browse rows into the internal `/search` shape.

do not add a generic `result` transport model shared by browse and search.

## recents rules

command palette recents must accept:

- `/browse`
- `/libraries`
- `/libraries/:id`
- `/media/:id`
- `/podcasts`
- `/podcasts/:podcastId`
- `/conversations`
- `/conversations/:id`
- `/search`
- `/settings`
- current shipped settings subroutes

command palette recents must reject:

- `/discover`
- `/documents`
- `/videos`
- `/podcasts/subscriptions`
- `/discover/podcasts`

do one explicit stored-data cleanup during the cutover:

- rewrite `/discover` recents to `/browse`
- delete `/documents` recents
- delete `/videos` recents

do not keep a runtime compatibility mapper in application code.

## files

### add

- `docs/browse-add-search-cutover.md`
- `apps/web/src/app/(authenticated)/browse/page.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- `apps/web/src/app/api/browse/route.ts`
- `python/nexus/api/routes/browse.py`
- `python/nexus/services/browse.py`
- `python/tests/test_browse.py`

### rename

- `apps/web/src/components/IngestionTray.tsx` to
  `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/components/IngestionTray.module.css` to
  `apps/web/src/components/AddContentTray.module.css`
- `apps/web/src/__tests__/components/IngestionTray.test.tsx` to
  `apps/web/src/__tests__/components/AddContentTray.test.tsx`

### change

- `docs/podcast-home-cutover.md`
- `docs/podcasts-first-class-section-cutover.md`
- `docs/podcast-show-surface-cutover.md`
- `apps/web/src/app/(authenticated)/layout.tsx`
- `apps/web/src/components/Navbar.tsx`
- `apps/web/src/components/Navbar.module.css`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/CommandPalette.module.css`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/__tests__/components/Navbar.test.tsx`
- `apps/web/src/__tests__/components/CommandPalette.test.tsx`
- `apps/web/src/lib/workspace/store-recents.test.tsx`
- `python/nexus/services/command_palette.py`
- `python/tests/test_command_palette_recents_integration.py`

### delete

- `apps/web/src/app/(authenticated)/discover/page.tsx`
- `apps/web/src/app/(authenticated)/discover/DiscoverPaneBody.tsx`
- `apps/web/src/app/(authenticated)/discover/page.module.css`
- `apps/web/src/app/(authenticated)/documents/page.tsx`
- `apps/web/src/app/(authenticated)/documents/DocumentsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/videos/page.tsx`
- `apps/web/src/app/(authenticated)/videos/VideosPaneBody.tsx`
- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/components/MediaCatalogPage.module.css`
- `apps/web/src/components/MediaCatalogPage.test.tsx`

delete those files only if nothing else in head still uses them after the cutover.

if a file survives, it must serve the final shipped semantics, not legacy route
ownership.

## implementation plan

1. add this doc.
2. amend the conflicting podcast docs so they agree that `Browse` owns
   acquisition and `Add` owns import.
3. add the explicit `/browse` route and explicit browse backend capability.
4. replace the current launcher-style discover page with the real browse page.
5. move podcast discovery ui from the add tray into browse.
6. rename `IngestionTray` to `AddContentTray`.
7. delete add-tray `Podcast` mode from head.
8. delete `/documents` and `/videos` routes from head.
9. remove `Documents` and `Videos` from navbar and command palette navigate
   actions.
10. rename `Discover` to `Browse` and `Chat` to `Chats` in shipped ui chrome.
11. update `/podcasts` actions and empty-state links so they point to browse
    rather than add.
12. update route ids, titles, subtitles, and active-state logic in the pane
    registry.
13. do one explicit recents cleanup in stored data.
14. delete dead tests, then update the surviving tests to the final model.

## acceptance criteria

- the desktop nav shows `Libraries`, `Browse`, `Podcasts`, `Chats`, `Search`,
  `Settings`, and a global `Add` action
- there is no shipped top-level `Discover`, `Documents`, or `Videos` item
- `/browse` is the only acquisition route
- `/browse` shows one query input, one type-filter row, and one result list
- `/browse` has no file-upload button, url-import form, or opml-import ui
- the add tray has no global podcast search mode
- the add tray exposes only import capabilities
- `/search` does not return or render external acquisition results
- `/podcasts` does not render browse or discovery rows
- `/podcasts` points to browse for acquisition and keeps export as a management
  action
- `Documents` and `Videos` no longer exist as top-level routes, route ids, nav
  items, or command palette navigate actions
- pane routing accepts `/browse` and rejects `/discover`, `/documents`, and
  `/videos`
- command palette recents accept `/browse` and reject `/discover`,
  `/documents`, and `/videos`
- there is no runtime route alias, redirect, compatibility branch, or legacy
  route mapper for removed paths
- the final implementation keeps browse, add, and search as three distinct
  capabilities with one primary form each

## validation commands

```bash
cd apps/web && bun run test
cd apps/web && bun run test:browser
cd python && uv run pytest -q
make verify
```
