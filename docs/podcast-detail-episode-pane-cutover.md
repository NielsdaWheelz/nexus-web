# podcast detail episode pane cutover

this brief defines the hard cutover from an inline episode section in podcast
detail to a split detail surface with a supporting episode pane.

it builds on:

- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)
- [docs/mobile-command-palette.md](./mobile-command-palette.md)

## goal

make the episode list a first-class supporting pane of podcast detail.

after this cutover:

- desktop podcast detail shows show-level detail in the primary column
- desktop podcast detail shows the episode list in a persistent secondary column
- mobile podcast detail keeps the show-level detail in the main body
- mobile podcast detail exposes one explicit `Episodes` action in the pane header
- the `Episodes` action opens the episode list in a mobile drawer
- the episode list exists in one place only

## scope

this change covers:

- podcast detail pane width and body mode
- podcast detail desktop split layout
- podcast detail mobile episode drawer
- podcast detail pane chrome action for mobile episode access
- podcast detail episode list placement and rendering
- focused frontend tests for the new layout contract

this change does not cover:

- podcast discovery or subscriptions list layout
- library membership semantics
- backend podcast detail or episodes api shape
- media pane linked-items behavior
- a generic workspace supporting-pane framework
- desktop pane resizing for the episode column

## product decision

podcast detail becomes a wide detail surface.

desktop uses two adjacent columns inside one pane:

- primary column: podcast summary, subscribe or unsubscribe actions, library
  membership, settings, and other show-level controls
- secondary column: episode count, filters, sort, search, list rows, row
  actions, and `Load more`

mobile keeps one visible content surface at a time.

mobile uses one pane-header action with visible text: `Episodes`.

tapping `Episodes` opens a right-side drawer titled `Episodes`.

the episode list is removed from the primary body.

there is no inline fallback copy of the episode list after cutover.

## hard cutover rules

- do a hard cutover. do not keep the old inline episode section alive behind
  flags, fallbacks, or compatibility branches.
- remove the inline `Episodes` section from the primary podcast body after the
  secondary pane lands.
- do not keep both the inline episode list and the secondary episode pane in the
  shipped ui.
- do not add backward-compatibility params, route aliases, or state adapters for
  the old inline layout.
- do not add a generic supporting-pane abstraction for this change.
- do not expand `SplitSurface` for podcast-specific behavior.
- do not add a desktop hide or show toggle for the episode pane.
- do not add a desktop resize divider for the episode pane in this cutover.
- do not add a floating action button for mobile episode access.
- do not duplicate episode-list rendering into separate desktop and mobile
  implementations unless a single shared render block becomes materially harder
  to read.

## implementation rules

- keep `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.tsx` as a
  thin wrapper.
- keep the podcast-detail control flow local and linear in
  `PodcastDetailPaneBody.tsx`.
- keep bff routes transport-only, per
  [docs/rules/layers.md](./rules/layers.md).
- keep existing podcast detail and episodes fetch paths. do not add new api
  routes for this layout change.
- keep episode list state in pane urls where it already exists: `state`, `sort`,
  and `q`.
- keep episode row navigation on `/media/[episodeId]`.
- keep episode row actions explicit and local to the existing episode rows.
- use the existing `usePaneChromeOverride` path to add the mobile-only
  `Episodes` action.
- keep the mobile branch local to `PodcastDetailPaneBody.tsx` and the existing
  pane chrome path.
- keep the desktop split layout local to
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.module.css`.
- do not add manifests, adapters, builders, registries, or intermediate models
  for the episode pane.
- do not extract a reusable podcast supporting-pane system.
- if the final render block becomes materially clearer with one extraction, the
  only allowed extraction is one local sibling component for the episode pane in
  the same directory.

## route and layout rules

`podcastDetail` in `apps/web/src/lib/panes/paneRouteRegistry.tsx` must change
to:

- `bodyMode: "document"`
- `defaultWidthPx: 960`
- `minWidthPx: 760`
- `maxWidthPx: 1400`

desktop layout rules:

- use one split layout inside `PodcastDetailPaneBody.tsx`
- keep the primary column flexible: `flex: 1` and `min-width: 0`
- keep the secondary column fixed at `380px`
- keep both columns independently scrollable
- keep a visible divider line via the secondary column border
- do not add a draggable divider
- do not add a collapsed desktop state

mobile layout rules:

- the pane header shows one visible `Episodes` action
- the action visible label is `Episodes`
- the action `aria-label` is `Episodes`
- the drawer title is `Episodes`
- the drawer opens from the right edge
- the drawer width is `min(92vw, 400px)`
- opening the drawer locks body scroll
- `Escape` closes the drawer
- tapping the backdrop closes the drawer
- opening or closing the drawer does not change the url

## content ownership rules

the primary column owns:

- podcast identity
- author and feed metadata
- subscribe and unsubscribe
- podcast-level library membership
- podcast-level settings
- show-level status and summary copy

the secondary episode pane owns:

- episode count
- state filter pills
- sort control
- episode search input
- episode rows
- episode row queue actions
- episode row transcript actions
- episode row library add or remove actions
- `Load more`

do not split ownership of those controls across both columns.

## implementation plan

1. update `podcastDetail` in
   `apps/web/src/lib/panes/paneRouteRegistry.tsx` to the new width and body-mode
   contract.
2. add a mobile-only `Episodes` pane action in
   `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
   via `usePaneChromeOverride`.
3. remove the inline `Episodes` `SectionCard` from the primary flow.
4. render the podcast summary and show-level controls in a primary column.
5. render the episode controls and episode list in one supporting pane render
   block.
6. mount that supporting pane block in a desktop secondary column.
7. mount that same supporting pane block in a mobile drawer.
8. add local drawer open, close, escape, backdrop, and body-overflow handling in
   `PodcastDetailPaneBody.tsx`.
9. add the split and drawer styles in
   `apps/web/src/app/(authenticated)/podcasts/[podcastId]/page.module.css`.
10. update route and component tests to assert the new contract and remove
    inline-episode assumptions.

## cases to cover

- subscribed podcast detail on desktop
- unsubscribed podcast detail on desktop
- subscribed podcast detail on mobile
- unsubscribed podcast detail on mobile
- mobile drawer closed
- mobile drawer open
- episode search with an active query
- episode filter change
- episode sort change
- episode pagination through `Load more`
- episode row library action from the desktop secondary pane
- episode row library action from the mobile drawer

## acceptance criteria

- desktop podcast detail opens as a wide pane with two adjacent columns.
- desktop podcast detail shows show-level detail in the primary column.
- desktop podcast detail shows the episode list in a persistent secondary
  column.
- the episode list no longer appears inline in the primary body.
- mobile podcast detail exposes one visible `Episodes` action in the pane
  header.
- mobile tapping `Episodes` opens a drawer labeled `Episodes`.
- mobile drawer close restores body scrolling.
- episode filters, sort, and search remain functional in the secondary pane.
- episode `Load more` remains functional in the secondary pane.
- episode row actions remain available from the secondary pane.
- podcast detail remains readable before subscribe, per
  [docs/podcast-library-cutover.md](./podcast-library-cutover.md).
- podcast-level library membership semantics remain unchanged.
- episode-level library membership semantics remain unchanged.
- the implementation stays local to the existing podcast detail route, pane
  registry, pane chrome override path, and podcast detail stylesheet.
- the implementation does not introduce a new supporting-pane framework, mobile
  launcher surface, or generic split abstraction.

## regression coverage

required frontend coverage includes:

- pane registry test: `podcastDetail` uses `bodyMode: "document"` with the new
  width contract
- browser component test: desktop podcast detail renders podcast summary and
  episode list side by side
- browser component test: mobile podcast detail shows a visible `Episodes`
  header action
- browser component test: tapping `Episodes` opens a dialog labeled `Episodes`
- browser component test: `Escape` closes the mobile drawer
- browser component test: backdrop click closes the mobile drawer
- browser component test: body overflow is restored after drawer close
- browser component test: episode search, filter, and sort operate from the
  secondary pane
- browser component test: episode row library actions still work from the
  secondary pane
- podcast flow test: episode library add or remove still works from podcast
  detail
- podcast action-menu test: unsubscribed podcast detail remains readable and
  actionable

## validation commands

```bash
cd apps/web && bun run test:browser
make verify
```
