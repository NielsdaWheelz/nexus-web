# mobile pane chrome cutover

this document defines the implementation target for smooth mobile pane chrome in
document panes.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, or backward-compatibility shims.

## goals

- make mobile reader chrome hide and reveal without sudden jumps
- maximize reading space on mobile document panes without losing orientation
- keep scroll ownership and visibility ownership obvious from the owning
  component
- remove layout coupling that shifts content while the user is scrolling
- keep reduced-motion behavior consistent across pdf, epub, web, and transcript
  readers

## non-goals

- desktop chrome redesign
- route registry redesign
- reader resume contract changes
- generic scroll behavior infrastructure
- continuous scroll-linked collapse or spring physics
- feature flags, staged rollouts, or compatibility modes

## target behavior

- on mobile, standard panes keep header and toolbar visible for the full
  session
- on mobile, document panes hide chrome only after deliberate downward reading
  scroll
- on mobile, document panes reveal chrome on deliberate upward scroll and near
  the top
- hide and reveal do not change the reader scroller's `scrollTop`
- hide and reveal do not shift the current text position or cause a visible
  content jump
- chrome motion is a short transform-based slide with optional opacity; no
  layout properties change with visibility state
- document panes keep one stable top protection value based on measured chrome
  height
- chrome does not hide before the reader has moved past the reserved top
  protection area
- quote drawers, highlights drawers, selection flows, library panels, and
  similar transient ui keep chrome visible until they close
- reduced-motion users keep chrome pinned visible on mobile document panes
- anchor jumps, deep links, search hits, and resume restore land below visible
  chrome
- `/media/:id` route decisions stay in `MediaPaneBody.tsx`; the real scroller
  only reports scroll position and local lock-visible conditions

## target structure

- `PaneShell.tsx` owns mobile document chrome hidden/visible state, measured
  chrome height, reduced-motion pinning, and the scroll callback consumed by
  real scrollers
- `PaneShell.module.css` owns chrome overlay positioning, motion, and the single
  reserved top space for document bodies
- `MediaPaneBody.tsx` owns web, epub, and transcript scroll handoff plus
  transient-ui lock-visible decisions
- `page.module.css` owns stable `scroll-padding-top` for non-pdf document
  scrollers
- `PdfReader.tsx` owns pdf scroll handoff and pdf-local lock-visible decisions
- `PdfReader.module.css` owns stable `scroll-padding-top` and
  `scroll-margin-top` for pdf page targets
- tests assert user-visible behavior and target placement, not internal helper
  structure

## final state

- there is one production path for mobile document chrome visibility
- `PaneShell` remains the only chrome layout owner for workspace panes
- the real reader scroller remains the only scroll owner for document-pane
  chrome
- hidden mobile document chrome no longer changes body padding or any other
  layout-affecting property
- mobile reader hide/show motion no longer depends on `visibility` snapping the
  chrome away immediately
- reduced-motion handling no longer differs between pdf and non-pdf readers
- scroll-padding and target protection no longer depend on whether chrome is
  currently hidden
- no stale docs or tests remain that describe padding-coupled hide/show
  behavior

## hard cutover rules

- delete the hidden-state body padding branch in `PaneShell.module.css`
- delete the immediate hidden-state `visibility` behavior that cuts off the exit
  motion
- do not keep both stable-geometry and padding-coupled hide/show paths
- do not keep pdf-only reduced-motion pinning once `PaneShell` owns
  reduced-motion behavior
- do not add a new hook, policy object, config model, manifest, adapter, or
  generic utility for this cutover
- do not move threshold values into a separate shared model or tuning table
- if logic is only needed in one owning component, inline it there
- if a helper, type, or constant is used once and does not hide substantial
  incidental complexity, inline or delete it

## key decisions

- keep scroll geometry stable
  reason: a small amount of permanently reserved top space is cheaper than
  moving the document under the user's finger while they read
- gate hide on measured chrome height
  reason: chrome must not hide while the scroller is still inside the reserved
  top protection zone
- pin reduced-motion users to visible chrome
  reason: this is simpler, more predictable, and safer than maintaining a second
  no-animation hide/show path
- keep hysteresis explicit and asymmetric
  reason: reveal on tiny reversals is the exact failure mode this cutover
  removes
- keep ownership local
  reason: repo rules favor direct branches in the owning component over
  reusable-looking indirection

## files in scope

- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `e2e/tests/pane-chrome.spec.ts`
- `e2e/tests/reader-resume.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/web-articles.spec.ts`
- `e2e/tests/youtube-transcript.spec.ts`

## file-by-file target

- `PaneShell.tsx`
  keep mobile chrome layout ownership here
  keep one linear hide/reveal path for document panes
  own reduced-motion pinning here instead of splitting it by reader type
  keep explicit branches on mobile, document, and locked-visible state
  require deliberate downward movement plus scroll position beyond the measured
  chrome height before hiding
  require deliberate upward movement or near-top reset before revealing
- `PaneShell.module.css`
  keep the chrome as an overlay surface
  keep one stable top reservation for document bodies
  animate only `transform` and optional `opacity`
  do not branch body padding by hidden state
  do not rely on immediate `visibility` changes for hide/show
- `MediaPaneBody.tsx`
  keep explicit scroll handoff for web, epub, and transcript document scrollers
  keep transient-ui lock-visible wiring local here
  do not add wrappers or helper layers around the scroll handoff
- `page.module.css`
  keep one stable `scroll-padding-top` based on `--mobile-pane-chrome-height`
  do not couple target protection to hidden vs visible chrome state
- `PdfReader.tsx`
  keep the pdf viewer as the explicit scroll owner for pdf chrome visibility
  keep pdf-local lock-visible conditions such as text selection
  delete any reduced-motion visibility ownership that becomes redundant once
  `PaneShell` owns it
- `PdfReader.module.css`
  keep one stable `scroll-padding-top`
  keep one stable `scroll-margin-top` for page targets
  do not add hidden-state compensation
- tests
  delete assertions that encode padding-coupled snap behavior
  replace them with assertions on deliberate hide, deliberate reveal,
  reduced-motion pinning, and target placement

## implementation rules

- use explicit branches on `bodyMode`, `isMobile`, `mobileChromeLockedVisible`,
  and reduced-motion state
- keep the scroll handler short, local, and linear
- keep thresholds inline unless a value is reused and semantically named
- do not add intermediate state models, config maps, or threshold objects
- do not add a second reusable scroll hook
- do not add a second context or controller layer
- prefer direct prop and context wiring that already exists over new
  abstractions
- animate only `transform` and `opacity`
- do not animate `padding`, `top`, `height`, `margin`, or other
  layout-affecting properties on scroll
- keep `scroll-padding-top` and `scroll-margin-top` stable from measured chrome
  height
- measure chrome height once in the owning shell and reuse the existing css
  custom property path
- if the final code needs comments to explain ownership, simplify the ownership
  instead

## acceptance criteria

- on mobile, reader chrome exits with a visible slide instead of snapping away
- on mobile, hiding reader chrome does not move the current paragraph, line, or
  highlight under the user's finger
- on mobile, tiny upward reversals do not reveal chrome
- on mobile, chrome does not hide before the document has scrolled past the
  reserved top protection area
- on mobile, deliberate upward scroll reveals chrome before the user reaches the
  very top
- on mobile, reduced-motion users see pinned chrome for pdf, epub, web, and
  transcript readers
- on mobile, quote drawers, highlights drawers, library panels, and selection
  flows keep chrome visible until they close
- web, epub, transcript, and pdf anchors still land below visible chrome
- resume restore still lands below visible chrome
- there is no duplicate production hide/show logic and no padding-coupled
  fallback path

## validation

- `make verify`
- `make test-e2e`
- targeted browser coverage for `PaneShell`
- targeted e2e coverage for pane chrome, reader resume, epub, pdf, web article,
  and transcript readers

## shipping bar

- do not ship partial cutover
- do not leave old code that can still toggle padding based on hidden chrome
  state
- do not leave pdf-only reduced-motion behavior in production
- do not leave docs or tests that describe the previous snap-prone behavior
