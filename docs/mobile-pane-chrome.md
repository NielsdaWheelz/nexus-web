# mobile pane chrome policy

this document defines when mobile top chrome stays pinned, when it may hide,
and what the implementation must guarantee.

implementation target and cutover details live in
`docs/mobile-pane-chrome-cutover.md`.

## scope

- applies to mobile workspace panes and mobile document/reader surfaces
- applies to pane headers, pane toolbars, and mobile overlay headers
- does not change desktop chrome behavior
- does not define backend, route, or reader-state contracts

## product policy

- standard panes keep pane chrome visible. this includes libraries, browse,
  search, chats, and settings.
- document panes may hide pane chrome on downward reading scroll. this
  includes media readers and any other pane whose route definition uses
  `bodyMode: "document"`.
- document panes must restore chrome near the top of the document and on
  intentional upward scroll.
- mobile overlay headers stay visible. do not auto-hide headers that are the
  only close or escape affordance.
- when a drawer, menu, selection popover, quote flow, or similar transient UI
  is open, keep the relevant chrome visible until that flow ends.

## implementation rules

- one surface owns chrome visibility. do not stack route-level hide/show logic
  on top of shell-level hide/show logic.
- the controlling scroll source must be the element that actually scrolls. do
  not drive document chrome from an ancestor wrapper when the document scrolls
  inside `DocumentViewport`, `PdfReader`, or another nested scroller.
- standard panes do not implement scroll-reactive chrome state.
- document panes use transform-based motion for chrome. do not animate height,
  top, padding, or other layout properties on every scroll frame.
- document panes reserve space for visible chrome and protect top scroll
  targets on the active scroller. restored anchors, search hits, and
  programmatic jumps must land below the visible chrome.
- mobile chrome must account for `100dvh` and `env(safe-area-inset-*)`.
- mobile chrome must not reveal on tiny scroll reversals. use explicit
  hysteresis with a near-top reset and larger reveal and hide thresholds than a
  single scroll tick.
- when `prefers-reduced-motion` is enabled, keep chrome pinned or switch state
  without animated motion.

## codebase policy

- keep the decision local to `PaneShell` for workspace panes.
- keep document-mode exceptions explicit at the call site that owns the scroll
  container.
- do not add a second generic chrome manager, manifest, registry, or policy
  layer.
- if a surface needs different behavior, branch explicitly in the owning
  component.
- prefer a small amount of duplicated code over a generic abstraction that
  hides which element owns scroll or visibility state.

## required coverage

- unit coverage for document-pane hide/show transitions, near-top reset, and
  reduced-motion behavior
- e2e coverage for media readers where the real scroller is nested inside the
  pane shell
- e2e coverage for anchor restore, deep links, and resume flows so visible
  targets are not hidden behind restored chrome
- e2e coverage for text selection, quote drawers, highlights drawers, and
  mobile overlays so visible affordances do not disappear mid-flow

## current implication

- the current workspace shell duplicates hide/show logic and does not yet bind
  document-pane chrome to the real nested scroller
- follow-up implementation should move the decision to the actual document
  scroll owner for `bodyMode: "document"` panes and keep standard panes pinned
