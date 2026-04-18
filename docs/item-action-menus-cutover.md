# item action menus cutover

this brief defines the hard cutover from mixed per-surface action menus,
pickers, and inline controls to one explicit item-action contract across pane
headers and item rows.

it builds on:

- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/function-parameters.md](./rules/function-parameters.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)
- [docs/library-target-picker-cutover.md](./library-target-picker-cutover.md)
- [docs/podcast-library-cutover.md](./podcast-library-cutover.md)
- [docs/podcast-detail-episode-pane-cutover.md](./podcast-detail-episode-pane-cutover.md)
- [docs/mobile-command-palette.md](./mobile-command-palette.md)

## goal

make item actions predictable everywhere in the app without introducing a
generic action framework.

after this cutover:

- pane-level secondary actions use one pane-chrome path
- row-level secondary actions use one row-menu path
- library membership uses one library picker path
- frequent primary actions stay visible inline instead of being hidden for
  artificial consistency
- the app no longer mixes bespoke kebab menus, flat per-library dropdown items,
  and screen-specific action layouts for the same capability

## scope

this change covers:

- pane header secondary actions
- row-level secondary actions for conversations, libraries, media, podcasts,
  episodes, and highlights
- library membership controls on media and podcast surfaces
- the placement rules for inline actions versus overflow actions
- focused frontend tests for the unified action contract

this change does not cover:

- inventing new product actions that do not exist today
- redesigning the command palette
- redesigning selection popovers or highlight edit popovers
- redesigning global player controls
- adding batch actions
- adding context menus
- adding keyboard shortcut systems for item actions
- backend route redesign unless a frontend surface is blocked on a missing
  explicit capability

## non-goals

- one universal `ItemActions` component
- one universal action schema shared by every entity
- one generic popup, menu, picker, or overlay framework
- one registry, manifest, builder, adapter, or action DSL
- one mixed `kind + target` action payload shape
- backward compatibility for old menu layouts
- keeping legacy action variants behind flags or fallback branches

## product decision

there are exactly two shared action primitives:

- `ActionMenu` for overflow commands
- `LibraryTargetPicker` for explicit library selection or membership changes

there are exactly three action placements:

- pane chrome `options` for pane-level secondary actions
- row `options` for row-level secondary actions
- inline `actions` for visible primary actions

the app does **not** collapse `ActionMenu` and `LibraryTargetPicker` into one
component.

the app does **not** put searchable selection ui inside `ActionMenu`.

the app does **not** encode library names as `ActionMenu` items.

the app does **not** hide high-frequency primary actions only to make surfaces
look superficially similar.

## target behavior

### pane-level actions

pane-level secondary actions live in pane chrome through
`usePaneChromeOverride({ options })` and render through `SurfaceHeader`.

pane-level primary actions, when needed, live in pane chrome through
`usePaneChromeOverride({ actions })`.

examples:

- conversation detail `Delete conversation` belongs in pane chrome `options`
- library detail `Edit library` and `Delete library` belong in pane chrome
  `options`
- mobile podcast detail `Episodes` belongs in pane chrome `actions`

### row-level actions

row-level secondary actions live in `AppListItem.options` when the row already
uses `AppListItem`.

rows that cannot use `AppListItem` without making the code materially harder to
read may render `ActionMenu` directly, but they must still follow the same
placement and labeling rules.

examples:

- conversation list `Delete`
- podcast subscriptions `Settings`, `Refresh sync`, `Unsubscribe`
- podcast episode rows `Mark as played`
- library detail row `Remove from library`
- linked item row `Edit highlight`, `Delete`

### library membership

all explicit library selection or membership changes use
`LibraryTargetPicker`.

`LibraryTargetPicker` remains a concrete library capability, not a generic
combobox abstraction.

examples:

- media detail `Libraries`
- podcast detail `Libraries`
- unsubscribed podcast detail `Add to library`
- media catalog row `Libraries`
- podcast subscription row `Libraries`
- episode row `Libraries`
- add-new-media `Choose library`

### inline primary actions

inline `actions` are reserved for frequent, high-salience actions that should
stay visible.

examples:

- `Subscribe`
- `Add to library` on unsubscribed podcast surfaces
- `Libraries` where membership is a primary surface concern
- `Play next`
- `Add to queue`
- mobile pane-header `Episodes`

destructive or infrequent actions move into `ActionMenu` unless the product
brief for that surface explicitly requires inline presentation.

## key decisions

### one action vocabulary, not one component

visual consistency comes from one action contract, not from forcing every
interaction through one primitive.

`ActionMenu` is a command surface.

`LibraryTargetPicker` is a searchable library-selection surface.

those are different interaction types and remain separate.

### keep control flow local

build each `options` array in the same component that owns the action handlers.

do not extract generic action builders, shared descriptors, or registry-backed
mappers.

if a surface branches by entity kind, keep that branch explicit and exhaustive
in the surface.

### keep primary actions visible

do not move `Subscribe`, `Libraries`, `Add to library`, `Play next`, or `Add to
queue` into overflow merely to reduce variation.

consistency matters, but hiding the primary action is worse than tolerating a
small amount of layout difference.

### one chrome path and one row path

use existing shared placement paths rather than inventing a new abstraction:

- pane chrome: `usePaneChromeOverride` -> `PaneShell` -> `SurfaceHeader`
- row menu: `AppListItem.options` -> `ActionMenu`

### hard cutover

remove old action layouts in the same changeset that introduces the new one.

do not keep alternate menu placements alive behind flags, props, or local
fallback branches.

## hard cutover rules

- do a hard cutover. do not keep old menu layouts behind flags, fallbacks, or
  compatibility branches.
- do not add an `ItemActions` wrapper, `useItemActions` hook, action manifest,
  registry, builder, adapter, or generic utility layer.
- do not add a generic popup or overlay abstraction.
- do not add a generic `kind + target` action model.
- do not add a generic mixed menu item type that tries to encode commands,
  selection, and membership in one shape.
- do not add new shared components unless the existing surface code becomes
  materially harder to read without one.
- do not keep flat per-library action lists in `ActionMenu`.
- do not keep bespoke podcast-detail action layout once the cutover lands.
- do not duplicate the same action in both inline controls and overflow on the
  same surface unless a product brief explicitly requires both.

## implementation rules

- keep action assembly local to each surface.
- keep handlers local to each surface.
- inline one-use `options` arrays and one-use labels unless the value is reused
  or has real semantic meaning.
- prefer direct `if` branches over layered helpers.
- when a row already uses `AppListItem`, prefer `options` over custom menu
  rendering.
- when a row cannot use `AppListItem` because of sortable or alignment-specific
  layout, keep the row local and render `ActionMenu` directly.
- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- if a missing product capability blocks the cutover, add the smallest explicit
  route or service change for that surface only.
- do not add shared frontend action data types beyond what `ActionMenu` and
  `LibraryTargetPicker` already require.

## files

### shared primitives to keep

- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/components/ui/ActionMenu.module.css`
- `apps/web/src/components/LibraryTargetPicker.tsx`
- `apps/web/src/components/LibraryTargetPicker.module.css`
- `apps/web/src/components/ui/AppList.tsx`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`

### core frontend surfaces in scope

- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/components/ConversationContextPane.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/components/MediaCatalogPage.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/components/LinkedItemRow.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`

### primary cutover targets

start with the surfaces that currently violate the target contract the most:

1. `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
2. `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
3. `apps/web/src/components/MediaCatalogPage.tsx`
4. `apps/web/src/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody.tsx`
5. `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`

### tests in scope

- `apps/web/src/__tests__/components/ActionMenu.test.tsx`
- `apps/web/src/__tests__/components/SurfaceHeader.test.tsx`
- `apps/web/src/__tests__/components/Pane.test.tsx`
- `apps/web/src/components/MediaCatalogPage.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/page.test.tsx`

## implementation plan

1. keep `ActionMenu` and `LibraryTargetPicker` as the only shared action
   primitives.
2. standardize pane-level secondary actions on the pane chrome `options` path.
3. standardize row-level secondary actions on `AppListItem.options` wherever
   the row already uses `AppListItem`.
4. update `PodcastDetailPaneBody.tsx` so show-level primary actions stay inline
   and show-level secondary actions move into one overflow menu.
5. update `LibraryPaneBody.tsx` so pane-level actions stay in pane chrome and
   mixed-entry row actions match the row-menu contract without introducing a
   sortable-row abstraction.
6. remove any remaining flat per-library `ActionMenu` items and replace them
   with `LibraryTargetPicker`.
7. remove any duplicated legacy action placements on touched surfaces.
8. update focused tests to assert final placement and remove old assumptions.

## cases to cover

- pane with no secondary actions
- pane with pane-chrome `options`
- pane with pane-chrome `actions`
- row with only inline primary actions
- row with only `ActionMenu`
- row with both inline primary actions and `ActionMenu`
- row with `LibraryTargetPicker`
- unsubscribed podcast detail
- subscribed podcast detail
- podcast subscriptions list
- library detail mixed-entry list
- media catalog rows
- linked-item rows
- mobile pane chrome
- disabled menu options
- destructive menu actions

## acceptance criteria

- every pane-level secondary action in scope is surfaced through pane chrome
  `options`.
- every row-level secondary action in scope is surfaced through one row-menu
  path.
- every explicit library selection or membership action in scope uses
  `LibraryTargetPicker`.
- no surface in scope renders a flat per-library `ActionMenu`.
- no surface in scope keeps both a new action layout and a legacy action layout.
- `PodcastDetailPaneBody.tsx` no longer uses a bespoke show-level action layout
  that diverges from the rest of the app.
- `LibraryPaneBody.tsx` keeps readable local sortable-row code while matching
  the shared action contract.
- the final implementation introduces no generic action framework.
- the final implementation keeps control flow local, linear, and explicit.

## validation commands

```bash
cd apps/web && bun run test:browser
cd apps/web && bun run test:unit
make verify
```
