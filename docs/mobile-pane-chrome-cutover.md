# mobile pane chrome cutover

this document defines the implementation target for mobile pane chrome.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, or backward-compatibility shims.

## goals

- maximize reading space on mobile document panes without hiding critical
  affordances
- keep standard mobile panes predictable and pinned
- bind chrome visibility to the element that actually scrolls
- make the code easy to understand from the owning component
- remove duplicate or partial implementations instead of layering new ones on
  top

## non-goals

- desktop chrome redesign
- route registry redesign
- reader resume contract changes
- generic scroll behavior infrastructure
- feature flags, gradual rollout paths, or fallback compatibility modes

## target behavior

- on mobile, standard panes keep their header and toolbar visible for the full
  session
- on mobile, document panes hide header and toolbar on intentional downward
  reading scroll
- on mobile, document panes restore header and toolbar near the top of the
  document and on intentional upward scroll
- on mobile, `/media/:id` route-level chrome decisions live in
  `MediaPaneBody.tsx`, and scroll-driven visibility lives only with the real
  scroller owner
- overlay headers, close bars, and other escape affordances stay visible
- while a drawer, quote flow, menu, selection flow, or other transient UI is
  open, the relevant chrome stays visible
- anchor jumps, deep links, resume restore, search hits, and selection restore
  land below visible chrome
- reduced-motion users do not get animated chrome motion

## final state

- `PaneShell` owns mobile chrome layout for workspace panes
- `PaneShell` does not run scroll-reactive hide/show logic for standard panes
- `MediaPaneBody.tsx` is the only `/media/:id` route controller
- document-pane chrome visibility is driven by the real document scroller, not
  by `PaneShell`'s outer body wrapper
- there is one mobile chrome behavior path for workspace panes
- `PageLayout` is deleted
- document panes use explicit local wiring at the scroll owner instead of a new
  generic abstraction layer

## hard cutover rules

- remove the current duplicate hide/show implementation split between
  `useMobileChromeVisibility` and `PaneShell`
- remove any unused production mobile hide/show path after the cutover
- do not keep both shell-driven and document-driven visibility state
- do not keep route-level chrome mutations in `useMediaRouteState.tsx` or move
  them into a replacement controller hook
- do not add optional props, mode flags, registries, manifests, or adapters to
  support both old and new behavior
- if a file becomes a one-use wrapper after the cutover, inline or remove it

## key decisions

- standard panes are pinned on mobile
  reason: these panes are navigational and action-heavy, not long-form reading
  surfaces
- document panes may auto-hide chrome on mobile
  reason: they are the only surfaces where extra vertical space materially
  improves the primary task
- the real scroller owns visibility state
  reason: nested scrollers already exist for media readers and resume logic
  already depends on the real scroller
- the implementation stays local and explicit
  reason: the repo rules favor fewer code paths and fewer abstractions over
  reusable-looking indirection

## files in scope

- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaRouteState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/transcriptView.ts`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `e2e/tests/pane-chrome.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/reader-resume.spec.ts`

## file-by-file target

- `PaneShell.tsx`
  keep mobile layout ownership here
  remove scroll-reactive hide/show state for standard panes
  expose one explicit document-pane path for visibility updates from the real
  scroller
- `PaneShell.module.css`
  keep pinned mobile chrome styles for standard panes
  keep transform-based hidden/visible styles for document panes only
  keep safe-area padding and reserved top space
- `MediaPaneBody.tsx`
  keep epub and web document-pane decisions explicit at the media surface
  absorb the remaining route-level mobile chrome decisions from the deleted
  media-route hook
  keep transient UI flows forcing visible chrome while they are open
- `useMediaRouteState.tsx`
  delete it
  move any remaining route-level chrome mutations into `MediaPaneBody.tsx`
  or the real leaf scroller owner
- `TranscriptContentPanel.tsx`
  keep transcript document scroll ownership local instead of routing it through
  a wrapper component
- `PdfReader.tsx`
  become the explicit scroll owner for pdf mobile chrome visibility
  protect page jumps and resume positioning from hidden or reappearing chrome
- `transcriptView.ts`
  keep transcript target placement aligned with the visible chrome height of the
  active scroller
- tests
  delete assertions that depend on the legacy shell-body-driven document
  behavior
  replace them with assertions on the real document scroller

## implementation rules

- use explicit branches on `bodyMode`
- use explicit branches on transient-ui-open state
- keep thresholds inline unless a value is reused and semantically named
- do not introduce a generic policy object or configuration model
- do not introduce a second reusable scroll hook unless multiple production
  owners still need the exact same logic after the cutover
- prefer direct prop wiring over context expansion
- prefer local state in the owning component over cross-surface shared state
- animate only with `transform` and `opacity`
- do not animate layout-affecting properties on scroll
- set top protection on the real scroller, not on an ancestor shell

## acceptance criteria

- on mobile, `/libraries`, `/browse`, `/search`, `/conversations`, and
  `/settings` keep pane chrome visible while scrolling
- on mobile, `/media/:id` hides pane chrome during intentional downward reading
  scroll for epub, web, transcript, and pdf readers
- on mobile, `/media/:id` restores pane chrome near the top and on intentional
  upward scroll
- on mobile, quote drawers, highlights drawers, overlays, and similar flows
  keep the necessary chrome visible until the flow closes
- epub, web, transcript, and pdf anchor jumps are not obscured by visible
  chrome
- reader resume restore does not snap content under the chrome
- reduced-motion mode disables animated hide/show motion
- no duplicate production hide/show logic remains for workspace pane chrome
- no deleted wrapper or alternate `PageLayout` chrome path remains in
  production

## validation

- `make verify`
- `make test-e2e`
- targeted browser and e2e coverage for mobile media readers

## shipping bar

- do not ship partial cutover
- do not leave old tests asserting the previous document-pane behavior
- do not leave dead mobile chrome code in production files
- if the final code still needs a comment to explain which element owns scroll,
  the ownership is still too indirect and should be simplified
