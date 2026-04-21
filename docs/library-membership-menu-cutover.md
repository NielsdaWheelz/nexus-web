# library membership menu cutover

this doc owns the hard cutover for library membership editing from
secondary-action surfaces in `apps/web/src/`.

it replaces the current split between:

- flat kebab menus
- standalone `Libraries` buttons
- row-only `Remove from library` commands
- the dual-mode membership behavior inside `LibraryTargetPicker`

after cutover, library membership editing has one primary form:

- a flat menu item labeled `Libraries…`
- a separate library membership panel opened from that item

choose-one library flows stay separate and keep using
`LibraryTargetPicker`.

## goals

- make pane-header and row secondary actions follow one obvious pattern
- keep menus command-only
- move library membership editing behind `Libraries…`
- remove duplicate membership entry points on the same surface
- remove `Remove from library` as a top-level row command
- keep control flow local, linear, and explicit
- keep the code easy to read without action manifests, builders, or hooks
- preserve accessible keyboard behavior and mobile-safe behavior

## non-goals

- no generic menu framework
- no submenu with search input
- no custom item renderer system inside `ActionMenu`
- no repo-wide rewrite of every action surface
- no changes to create/follow/import flows that choose one target library
- no backend contract redesign
- no backward compatibility layer
- no legacy dual-mode picker behavior

## target behavior

### shared pattern

- the kebab trigger remains the secondary-action entry point
- the menu stays a flat list of commands
- any surface that allows membership editing includes a `Libraries…`
  menu item
- selecting `Libraries…` closes the menu and opens a separate library
  membership panel
- the panel stays open after add or remove so the user can make multiple
  changes
- `Escape`, outside click, and explicit close all dismiss the panel
- focus returns to the kebab trigger when the panel closes

### media pane header

- the pane header no longer renders a standalone `Libraries` button
- the pane header `Options` menu includes `Libraries…`
- existing media-specific commands stay in the same menu:
  - `Open source`
  - EPUB table-of-contents toggle
  - reader theme commands
- `Libraries…` uses the current media membership data and mutations
- on desktop, the panel opens anchored to the pane-header kebab
- on mobile, the panel opens as a sheet or dialog instead of a small
  anchored popover

### library detail rows

- every row keeps the `Actions` kebab
- row menus no longer contain `Remove from library`
- row menus contain `Libraries…`
- the panel shows all non-default libraries for that item, including the
  current library
- removing the current library from inside its own detail page removes that
  row from the list immediately
- if the row item belongs to other libraries, those memberships are visible
  and editable in the same panel

### podcast list and detail membership surfaces

- any existing standalone `Libraries` membership button on a podcast row,
  episode row, or subscribed-show header is removed
- the same surfaces move membership editing behind `Libraries…` in their
  existing kebab menu
- exact non-membership commands remain surface-specific

### library membership panel

- the panel has one job: edit membership across non-default libraries
- it shows:
  - search input
  - loading state
  - empty state
  - inline error state
  - one flat list of libraries
- each library row is a direct action:
  - if the item is already in that library, the row action is remove
  - otherwise, the row action is add
- the panel serializes mutations:
  - at most one add or remove runs at a time per open panel
  - while one mutation is in flight, the panel disables further changes
- the panel does not own fetching rules beyond "load when opened"
- the panel does not own business logic for media vs podcast

## final state

### ui structure

- `ActionMenu` remains a small flat-menu primitive
- `ActionMenu` does not grow custom content slots, item render props,
  submenu APIs, or generic panel orchestration
- one concrete `LibraryMembershipPanel` component owns the membership panel
  UI because that complexity is real and reused
- `LibraryTargetPicker` becomes selection-only
- no component owns both:
  - choose-one library selection
  - membership add/remove editing

### state ownership

- each surface keeps its own menu item list inline
- each surface keeps its own panel open state inline
- each surface keeps its own membership fetch and mutation wiring inline or
  in the local state owner it already has
- media membership state stays in `useMediaViewState.tsx`
- library detail row membership state stays in `LibraryPaneBody.tsx`
- podcast membership state stays in the existing podcast pane bodies
- there is no new shared membership hook
- there is no new shared action schema
- there is no new builder, adapter, manifest, or intermediate menu model

### action menu shape

- `ActionMenu` gets only the minimum API change needed to let a caller open
  the membership panel from the same trigger
- do not add general item metadata for arbitrary overlay types
- do not add menu item variants beyond what the current real call sites need
- keep call sites explicit

### code shape

- branch explicitly on surface and item kind
- keep `if` and `switch` chains local and exhaustive
- inline one-use objects and one-use constants
- extract only:
  - `LibraryMembershipPanel`
  - its stylesheet
  - its test
- every other new helper, type, or wrapper must clear a high bar

## key decisions

### 1. menu and membership panel stay separate

the menu is for commands.

the membership editor is not a menu item with nested interactive controls.

the cutover keeps that separation strict.

### 2. `Libraries…` is the only membership entry point on these surfaces

the current split between kebab menu, standalone button, and row-only remove
action makes the behavior harder to predict.

the cutover removes that split.

### 3. keep state local instead of inventing a shared orchestration layer

the surfaces already own the relevant item identity, fetch timing, and
mutation callbacks.

adding a generic membership controller would add indirection without enough
payoff.

### 4. split selection from membership editing

`LibraryTargetPicker` currently hides two different capabilities behind one
optional-prop surface.

that is harder to understand than two explicit components with one job each.

after cutover:

- `LibraryTargetPicker` means choose one library
- `LibraryMembershipPanel` means edit membership

### 5. remove `Remove from library` instead of preserving it

once `Libraries…` opens the full membership panel, a top-level remove command
is redundant.

keeping both would reintroduce duplicate paths for the same capability.

## rules

- follow `docs/rules/simplicity.md`
- follow `docs/rules/module-apis.md`
- follow `docs/rules/control-flow.md`
- follow `docs/rules/codebase.md`
- follow `docs/rules/conventions.md`
- follow `docs/rules/testing_standards.md`

feature-specific implementation rules:

- do not add a generic menu-plus-panel abstraction
- do not add a `useLibraryMembershipPanel` hook
- do not add a shared action manifest or action builder
- do not keep membership mode inside `LibraryTargetPicker`
- do not keep standalone `Libraries` buttons on surfaces covered by this
  cutover
- do not keep `Remove from library` as a top-level row menu item
- do not add submenu search inputs
- do not add compatibility props to preserve the old split behavior

## files

### add

- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LibraryMembershipPanel.module.css`
- `apps/web/src/components/LibraryMembershipPanel.test.tsx`

### modify

- `apps/web/src/components/ui/ActionMenu.tsx`
- `apps/web/src/__tests__/components/ActionMenu.test.tsx`
- `apps/web/src/components/LibraryTargetPicker.tsx`
- `apps/web/src/components/LibraryTargetPicker.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/page.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-action-menus-cutover.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/podcasts-flows.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.test.tsx`
- `docs/reader-implementation.md`

### delete

- membership-mode props and branches from `LibraryTargetPicker.tsx`
- tests that assert membership-mode behavior in
  `LibraryTargetPicker.test.tsx`
- standalone `Libraries` membership buttons from covered surfaces
- top-level `Remove from library` row menu entries from covered surfaces

### do not modify

- backend library membership routes unless an implementation bug proves a
  real gap
- add/follow/import selection-only flows in:
  - `BrowsePaneBody.tsx`
  - `AddContentTray.tsx`
  - unsubscribed podcast subscribe flows

## acceptance criteria

### behavior

- media pane header has no standalone `Libraries` button
- covered row surfaces have no standalone `Libraries` button
- covered row menus have no `Remove from library` item
- every covered membership-editing surface exposes `Libraries…` in the kebab
  menu
- selecting `Libraries…` closes the menu and opens the membership panel
- the panel stays open after a successful add or remove
- removing the current library entry from library detail removes the row
  from the list immediately

### accessibility

- pane-header menus still use the `Options` button label
- row menus still use the `Actions` button label
- menu interactions still follow `button -> menuitem`
- the membership panel is not rendered as a submenu
- focus returns to the source trigger when the panel closes
- mobile uses a dialog or sheet presentation, not a tiny anchored popover

### code shape

- `ActionMenu` remains a flat-menu component
- no file introduces a generic action schema or menu model
- no covered surface uses `LibraryTargetPicker` for membership editing
- no code path preserves the old standalone membership button behavior
- no code path preserves top-level `Remove from library` row commands

### tests

- `ActionMenu` tests cover the new trigger-to-panel handoff contract
- `LibraryMembershipPanel` tests cover:
  - load
  - search
  - add
  - remove
  - disabled while busy
  - close and focus restore
- media pane tests assert `Libraries…` lives in the header menu
- library detail tests assert membership editing moved off the row remove
  command
- podcast tests assert covered surfaces no longer render standalone
  membership buttons

## validation commands

```bash
make verify
cd apps/web && bunx vitest run --config vitest.config.ts \
  src/__tests__/components/ActionMenu.test.tsx \
  src/components/LibraryMembershipPanel.test.tsx \
  src/components/LibraryTargetPicker.test.tsx \
  src/app/\(authenticated\)/media/\[id\]/MediaPaneBody.test.tsx \
  src/app/\(authenticated\)/libraries/\[id\]/page.test.tsx \
  src/app/\(authenticated\)/podcasts/podcasts-action-menus-cutover.test.tsx \
  src/app/\(authenticated\)/podcasts/podcasts-flows.test.tsx \
  src/app/\(authenticated\)/podcasts/\[podcastId\]/PodcastDetailPaneBody.test.tsx
```
