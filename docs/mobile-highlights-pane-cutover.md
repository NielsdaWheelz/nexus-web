# mobile highlights pane cutover

this document defines the implementation target for the mobile highlights pane
in media readers.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, or backward-compatibility shims.

## goals

- make the mobile secondary pane reflect the visible reader viewport
- remove clipped and partial highlight rows
- keep current page/section/content highlight scoping
- keep the implementation local to the owning reader and linked-items files
- remove the current raw mobile list behavior instead of layering on top of it

## non-goals

- desktop linked-items redesign
- document-wide or library-wide highlights browsing
- `all highlights`, `this section`, or mode-toggle UI in the mobile drawer
- backend highlight fetch contract changes
- new shared viewport, scroll, or indicator infrastructure
- feature flags, gradual rollout paths, or compatibility modes

## target behavior

- on mobile, the highlights drawer shows only highlights whose source anchor is
  in view in the current reader viewport
- on mobile, in-view detection uses the real reader scroll container, not the
  drawer scroll container
- on mobile, a highlight counts as in view when part of its source anchor
  intersects the reader viewport, with a small explicit stability buffer so
  rows do not churn on tiny scroll changes
- on mobile, offscreen contextual highlights do not render as rows
- on mobile, partial or clipped offscreen highlight rows do not render
- on mobile, if contextual highlights exist above the viewport, show a compact
  `N above` indicator at the top of the pane
- on mobile, if contextual highlights exist below the viewport, show a compact
  `N below` indicator at the bottom of the pane
- on mobile, tapping an above/below indicator scrolls the reader to the
  nearest offscreen highlight in that direction and keeps the drawer open
- on mobile, if there are no highlights in view but offscreen contextual
  highlights exist, show `No highlights in view.`
- on mobile, if the contextual set is empty, keep `No highlights in this
  context.`
- on mobile, pane copy must explicitly say `visible highlights`
- on desktop, keep the current aligned pane behavior
- on desktop, keep the current page/section/content pane titles and contextual
  ordering
- pdf, epub, transcript, and web readers follow the same mobile rule:
  viewport-local rendering inside the current page/section/content context

## final state

- the mobile highlights drawer has one meaning: visible highlights only
- the current raw contextual mobile list is removed
- current highlight loading stays scoped to active page, active section, or
  current content
- offscreen contextual highlights are represented only by `above` and `below`
  indicators
- `LinkedItemsPane` owns row rendering, anchor measurement, in-view filtering,
  and indicator rendering
- `MediaHighlightsPaneBody` owns contextual ordering, pane copy, and the
  explicit mobile vs desktop branch
- the old `alignToContent={!isMobile}` split does not survive the cutover
- there is no document-wide highlights browsing path in the mobile reader
  drawer

## hard cutover rules

- remove the current mobile list mode that renders every contextual highlight
- remove any code path that can still show a clipped or partial offscreen row
  on mobile
- do not add a toggle between `in view` and `this section/page`
- do not add a second data model for visible highlights; derive visible rows
  from the existing contextual highlight set
- do not add a new generic viewport manager, manifest, adapter, helper layer,
  or reusable policy object
- if a helper exists only to preserve the old mobile list branch, inline or
  delete it
- do not keep tests that assert the old mobile full-list behavior

## key decisions

- mobile is a viewport companion, not a contextual index
  reason: on mobile the drawer temporarily replaces the reader as the active
  surface, so it must describe what matters at the current reading position
- offscreen items use explicit indicators, not truncated previews
  reason: a clipped row looks broken and does not communicate whether the item
  is partly visible, offscreen, or actionable
- current fetch scope stays page/section/content scoped
  reason: existing code and tests already define that contract; this cutover is
  a rendering change inside that contract
- desktop behavior stays aligned and unchanged
  reason: desktop has space for the existing anchor-aligned side pane and does
  not have the mobile drawer ambiguity
- focus does not auto-retarget while the user scrolls
  reason: selection churn makes the pane feel unstable and adds unnecessary
  state coupling between scroll position and expansion state
- the implementation stays local and explicit
  reason: the component has one production owner and the repo rules favor fewer
  code paths and fewer abstractions over reusable-looking indirection

## files in scope

- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/LinkedItemsPane.module.css`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `e2e/tests/non-pdf-linked-items.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/youtube-transcript.spec.ts`

## file-by-file target

- `MediaHighlightsPaneBody.tsx`
  keep current contextual sorting and page/section/content scoping
  make the mobile branch explicitly target visible highlights
  make mobile copy explicitly say `visible highlights`
  keep desktop copy and ordering behavior intact
- `LinkedItemsPane.tsx`
  keep the current desktop aligned path
  replace the raw mobile list path with in-view filtering plus `above` and
  `below` indicators
  compute mobile visibility from the same source anchors already used for
  desktop measurement
  keep row click scroll-to-source behavior
  add indicator click jump behavior for nearest offscreen highlight
- `LinkedItemsPane.module.css`
  keep the aligned desktop pane clipped
  add explicit styles for `above` and `below` indicators
  ensure mobile rows are either fully rendered or not rendered at all
- tests
  delete assertions that depend on the old mobile full-list behavior
  add assertions for `No highlights in view.`
  add assertions for `N above` and `N below`
  add assertions that offscreen rows do not appear until their anchors are in
  view

## implementation rules

- branch explicitly on mobile vs desktop behavior
- keep control flow linear and local to the owning files
- prefer local explicit code over reusable-looking abstraction
- keep one-use constants inline unless the value has real semantic meaning or
  is reused
- keep one-use helpers inline unless they hide substantial incidental
  complexity
- do not add a new shared highlight view model or a second normalized row shape
- do not add a generic `mode` configuration object, strategy object, or policy
  map
- derive above/below counts directly from ordered highlights and measured anchor
  positions
- use explicit branches for pdf vs non-pdf anchor measurement
- use the real reader viewport for visibility math
- do not auto-scroll the drawer to simulate visibility
- do not use partial rows as overflow affordances

## implementation order

1. write failing component and browser tests from the acceptance criteria
2. cut `LinkedItemsPane` mobile rendering over to in-view filtering and
   explicit indicators
3. update `MediaHighlightsPaneBody` mobile copy and branch wiring
4. update mobile e2e coverage for web/transcript, epub, and pdf readers
5. remove stale tests and dead mobile list code

## acceptance criteria

- on mobile, opening the highlights drawer does not show a clipped or partial
  row for an offscreen highlight
- on mobile, only highlights with anchors in the current reader viewport render
  as rows
- on mobile, offscreen contextual highlights render only as `N above` and
  `N below` indicators
- on mobile, tapping `N above` scrolls to the nearest offscreen highlight above
  the viewport and reveals its row
- on mobile, tapping `N below` scrolls to the nearest offscreen highlight below
  the viewport and reveals its row
- on mobile, when no highlights are in view but contextual highlights exist,
  the pane shows `No highlights in view.`
- on mobile, when the contextual set is empty, the pane shows
  `No highlights in this context.`
- on mobile, scrolling a visible highlight out of view removes its row instead
  of clipping it
- on mobile, scrolling a contextual highlight into view renders its full row
- on desktop, aligned linked-items behavior and overflow clipping stay
  unchanged
- epub remains scoped to the active section
- pdf remains scoped to the active page
- transcript and web readers remain scoped to the current content
- no production code path remains that can render the old mobile full
  contextual list

## validation

- `make verify`
- `make test-e2e`
- targeted browser and e2e coverage for mobile highlights drawers on web,
  transcript, epub, and pdf readers

## shipping bar

- do not ship partial cutover
- do not leave dead mobile list code in production files
- do not leave tests asserting the previous mobile behavior
- if the final code still needs a comment to explain which viewport decides row
  visibility, the ownership is still too indirect and should be simplified
