# media highlights pane cutover

this brief defines the hard cutover from a scope-switching linked-items pane to
an explicit contextual highlights pane with one separate `All highlights` view.

it builds on:

- [docs/reader-research.md](./reader-research.md)
- [docs/reader-implementation.md](./reader-implementation.md)
- [docs/podcast-detail-episode-pane-cutover.md](./podcast-detail-episode-pane-cutover.md)
- [docs/mobile-selection-popover.md](./mobile-selection-popover.md)
- [docs/rules/simplicity.md](./rules/simplicity.md)
- [docs/rules/module-apis.md](./rules/module-apis.md)
- [docs/rules/control-flow.md](./rules/control-flow.md)
- [docs/rules/layers.md](./rules/layers.md)
- [docs/rules/function-parameters.md](./rules/function-parameters.md)
- [docs/rules/testing_standards.md](./rules/testing_standards.md)

## goal

make the reader secondary pane obvious, contextual, and easy to understand.

after this cutover:

- the reader has one default highlights pane, not a generic `Scope` surface
- the default pane always shows the reader's current context
- broader highlight browsing is entered through one explicit `All highlights`
  action
- the user never has to infer whether a tiny toggle changed layout, data source,
  navigation behavior, or pagination rules
- the implementation stays local and linear in the existing media pane path

## target behavior

desktop:

- the media pane keeps a persistent secondary highlights column
- the secondary column defaults to the contextual highlights view
- the contextual view is:
  - pdf: highlights on the active page
  - epub: highlights in the active chapter
  - web article and transcript: highlights in the current readable document
- the contextual view uses aligned layout only when the content supports it
- the secondary column has one explicit text action: `All highlights`
- activating `All highlights` replaces the contextual view with a list-only
  cross-document index inside the same secondary column
- the `All highlights` view has one explicit text action: `Back to highlights`

mobile:

- the pane header shows one visible `Highlights` action
- tapping `Highlights` opens a right-side drawer titled `Highlights`
- the drawer defaults to the contextual highlights view
- the drawer uses the same explicit `All highlights` and `Back to highlights`
  actions inside the drawer body header
- opening or closing the drawer does not change the url

reader navigation:

- selecting a row in the contextual view focuses that highlight in place
- selecting a row in `All highlights` navigates the reader to the target
  page/chapter/document location and focuses the highlight
- `All highlights` remains an explicit list view; it does not switch into
  aligned mode

focus mode:

- focus mode remains the only supported path that hides the highlights pane
- there is no separate desktop hide or show toggle for highlights outside focus
  mode

## scope

this change covers:

- media pane desktop highlights column layout
- media pane mobile highlights drawer
- removal of the `Scope` segmented control
- introduction of one explicit `All highlights` view
- highlights pane header copy and actions
- pdf and epub contextual highlight behavior
- removal of desktop resize and collapse behavior for the highlights column
- focused frontend tests for the new contract

this change does not cover:

- highlight creation or edit popover behavior
- highlight data model changes
- backend highlight api shape changes
- a generic workspace supporting-pane framework
- a generic reader subview framework
- a new workspace route or pane type for `All highlights`

## product decision

the reader secondary pane is a contextual reading aid by default.

it is not a generic `scope` control surface.

the shipped ui uses two explicit named views:

- `Highlights`
- `All highlights`

the shipped ui does **not** use:

- `Scope`
- `This page` versus `Entire document` chips
- `This chapter` versus `Entire book` chips
- a desktop resize handle for the highlights column
- a desktop collapse toggle for highlights

`All highlights` is a distinct explicit view, not a filter chip on the
contextual view.

the app does **not** keep a mix of:

- a contextual aligned pane
- a broad list index
- hidden layout changes
- hidden navigation changes

behind one small segmented control.

## key decisions

- remove the word `Scope` from the shipped ui
- keep the contextual highlights pane as the default secondary surface
- make broad browsing explicit with one `All highlights` action
- keep `All highlights` local to the media pane; do not add a new route
- keep contextual and broad browsing as two explicit render branches in the
  existing pane body
- keep aligned layout only for contextual views that actually have local anchors
- keep `All highlights` list-only on both desktop and mobile
- keep mobile open or close behavior in the existing pane chrome plus local
  drawer path
- remove the desktop resize divider and fixed-width state
- remove the desktop collapse state and collapse action
- keep all view-switching state local and reset it to contextual on mount,
  media change, and drawer reopen

## hard cutover rules

- do a hard cutover. do not keep the old `Scope` ui alive behind flags,
  fallbacks, or compatibility branches.
- remove the `Scope` label and segmented control from the highlights pane.
- remove the `page/document` and `chapter/book` user-facing toggle model.
- do not keep both the old scope toggle and the new explicit `All highlights`
  action in the shipped ui.
- do not add a generic `scope` enum, registry, manifest, or config layer.
- do not add a generic reader subview framework.
- do not add a new pane route, route alias, or query param for this cutover.
- do not add backward-compatibility state adapters for the old scope model.
- do not add a desktop resize divider for the highlights column.
- do not add a desktop hide or show toggle for the highlights column.
- do not add a second mobile launcher surface for highlights.
- do not keep one-use layout helpers, one-use pane-shaping adapters, or
  one-use constants when the branch can stay readable inline.

## implementation rules

- keep `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` as the
  media pane shell.
- keep the highlights pane control flow local and linear in
  `MediaLinkedItemsPaneBody.tsx`.
- keep `useMediaViewState.tsx` responsible for reader state, navigation state,
  and highlight fetching only.
- keep bff routes transport-only, per [docs/rules/layers.md](./rules/layers.md).
- keep existing highlight fetch paths. do not add new api routes for this
  cutover.
- keep the mobile branch local to `MediaPaneBody.tsx` and the existing pane
  chrome path.
- keep the desktop split layout local to
  `apps/web/src/app/(authenticated)/media/[id]/page.module.css`.
- keep pdf and epub behavior explicit with direct `if` branches in the pane
  body.
- do not add intermediate models, wrappers, builders, manifests, adapters, or
  generic utilities for the two view branches.
- if a value or object shape is used once, inline it unless it hides substantial
  incidental complexity.
- if a helper only chooses between contextual and `All highlights` layout, keep
  that branch inline at the call site.

## route and layout rules

`media` in `apps/web/src/lib/panes/paneRouteRegistry.tsx` must remain
`bodyMode: "document"` and must get an explicit width contract that assumes a
persistent reader plus highlights split on desktop.

desktop layout rules:

- use one split layout inside `MediaPaneBody.tsx`
- keep the reader column flexible: `flex: 1` and `min-width: 0`
- keep the highlights column fixed at `360px`
- keep a visible divider line via the highlights column border
- do not add a draggable divider
- do not add a collapsed desktop state
- do not add a hide or show button for the highlights column

mobile layout rules:

- the pane header shows one visible `Highlights` action
- the action visible label is `Highlights`
- the action `aria-label` is `Highlights`
- the drawer title is `Highlights`
- the drawer opens from the right edge
- the drawer width is `min(92vw, 400px)`
- opening the drawer locks body scroll
- `Escape` closes the drawer
- tapping the backdrop closes the drawer
- opening or closing the drawer does not change the url

## view rules

### contextual highlights

the contextual view owns:

- the default highlights list shown beside the reader
- aligned desktop positioning when the content has local anchors
- pdf current-page highlights
- epub current-chapter highlights
- web article and transcript current-document highlights
- the contextual empty state

contextual view copy must be explicit:

- pdf: `Page highlights`
- epub: `Chapter highlights`
- web article and transcript: `Highlights`

### all highlights

the `All highlights` view owns:

- the full document or book highlight index
- pagination through `Load more` when the underlying api supports it
- list ordering only
- cross-page and cross-chapter navigation

`All highlights` does **not** own:

- aligned row positioning
- ambiguous `Scope` copy
- per-content segmented controls

## file ownership

primary files to change:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaLinkedItemsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/LinkedItemsPane.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`

files to simplify or remove during the cutover:

- `apps/web/src/lib/media/linkedItemsLayoutMode.ts`
- `apps/web/src/lib/media/linkedItemsLayoutMode.test.ts`
- one-use pane-shaping helpers in
  `apps/web/src/lib/highlights/highlightIndexAdapter.ts`
- `DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX` in
  `apps/web/src/lib/panes/paneRouteRegistry.tsx` if the highlights width no
  longer needs shared state

files that should stay untouched unless the implementation proves otherwise:

- `python/nexus/api/routes/highlights.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/pdf_highlights.py`

## implementation plan

1. update the media pane width contract in
   `apps/web/src/lib/panes/paneRouteRegistry.tsx` for a fixed desktop reader +
   highlights split.
2. remove linked-pane resize and collapse state from
   `MediaPaneBody.tsx`.
3. keep the existing mobile drawer path, but rename the user-facing surface to
   `Highlights`.
4. replace the `Scope` control in `MediaLinkedItemsPaneBody.tsx` with one local
   explicit view state:
   - contextual highlights
   - `All highlights`
5. make contextual highlights the default branch on mount, media change, and
   drawer reopen.
6. inline the layout choice in `MediaLinkedItemsPaneBody.tsx` and delete
   `linkedItemsLayoutMode.ts`.
7. inline one-use pane item shaping in `MediaLinkedItemsPaneBody.tsx`; keep only
   reused pdf stable-sort code if it still has real payoff.
8. keep `LinkedItemsPane.tsx` for contextual aligned or list rendering only.
9. render the explicit `All highlights` branch as a plain list with explicit
   header copy and `Load more` behavior.
10. update focused browser-mode component tests and route contract tests to
    assert the new behavior and delete scope-specific assumptions.

## files and concrete changes

`MediaPaneBody.tsx`:

- remove `linkedWidth`
- remove `desktopLinkedCollapsed`
- remove resize handlers
- remove the desktop hide or show highlights action
- keep the mobile drawer open or close behavior
- rename drawer copy from `Linked items` to `Highlights`

`MediaLinkedItemsPaneBody.tsx`:

- remove `epubHighlightScope`
- remove `pdfHighlightScope`
- remove `handleEpubScopeChange`
- remove `handlePdfScopeChange`
- add one explicit local view state for contextual versus `All highlights`
- render one explicit local header for the active view
- keep pdf and epub fetch branches explicit
- keep pdf and epub navigation branches explicit

`useMediaViewState.tsx`:

- keep highlight fetch ownership as-is
- keep `handleLinkedItemsScopeChange` only if it still has a real payoff after
  the old scope model is removed
- otherwise inline the reset behavior at the remaining call site and delete the
  helper

`page.module.css`:

- remove scope-toggle styles
- remove resize-handle styles
- add explicit fixed-width desktop highlights column styles
- keep drawer styles local

`LinkedItemsPane.tsx`:

- keep aligned mode and list mode only
- do not teach it about `All highlights` as a product concept
- let the caller choose aligned versus list explicitly

## acceptance criteria

- the shipped ui contains no `Scope` label and no `This page` or `Entire
  document` segmented control.
- desktop media opens with a persistent highlights column and no resize handle.
- desktop media opens with no highlights collapse toggle.
- mobile media exposes one visible `Highlights` action in the pane header.
- mobile tapping `Highlights` opens a drawer labeled `Highlights`.
- the default highlights surface is contextual:
  - pdf uses the active page
  - epub uses the active chapter
  - web article and transcript use the current document
- the contextual surface remains aligned on desktop only when the content has
  local anchors.
- `All highlights` is entered through one explicit action and is clearly labeled
  `All highlights`.
- `All highlights` is always list-only.
- clicking an item in `All highlights` navigates to the correct target and
  focuses the highlight.
- drawer close restores body scrolling.
- focus mode remains the only supported way to hide the highlights pane.
- the implementation stays local to the existing media pane route, pane chrome
  path, pane stylesheet, and linked-items component path.
- the implementation does not introduce a generic supporting-pane framework, a
  generic scope system, or a new route for this cutover.

## non-goals

- redesigning highlight creation
- redesigning highlight edit popovers
- changing backend highlight schemas or endpoints
- adding cross-media or cross-library highlight search
- adding tags, color filters, author filters, or full-text highlight search
- adding a saved-reader-subview system
- adding a reusable secondary-pane framework

## regression coverage

required frontend coverage includes:

- pane registry test: `media` uses the explicit document-width contract needed
  for the new fixed split
- browser component test: desktop media renders the reader and highlights column
  side by side with no resize handle
- browser component test: desktop media does not expose a hide or show
  highlights action outside focus mode
- browser component test: mobile media shows a visible `Highlights` header
  action
- browser component test: tapping `Highlights` opens a dialog labeled
  `Highlights`
- browser component test: `Escape` closes the mobile highlights drawer
- browser component test: backdrop click closes the mobile highlights drawer
- browser component test: body overflow is restored after drawer close
- browser component test: pdf contextual view shows active-page highlights only
- browser component test: epub contextual view shows active-chapter highlights
  only
- browser component test: `All highlights` renders as a list and supports `Load
  more` where applicable
- browser component test: selecting an `All highlights` row navigates and
  focuses correctly

## validation commands

```bash
cd apps/web && bun run test:browser
make verify
```
