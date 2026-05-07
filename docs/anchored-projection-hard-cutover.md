# Anchored Projection Hard Cutover

## Role

This document is the target-state plan for replacing media-specific highlight
side-pane positioning with one anchored projection subsystem for reader
surfaces: web articles, EPUB sections, transcripts, and PDFs.

The implementation is a hard cutover. The final state keeps no feature flag, no
legacy `LinkedItemsPane` measurement path, no section-scoped desktop highlight
pane behavior, no active-page-only PDF pane behavior, no mobile-only visibility
filter, no compatibility adapter for old pane props, no fallback row rendering
when the target is not visible, and no persisted viewport or pixel state.

The cutover separates durable anchors from transient reader layout:

```text
DurableAnchor
  -> RenderedAnchor
      -> ViewportProjection
          -> AnchoredPaneLayout
```

`DurableAnchor` is saved product data or resolver output. It is not a layout
contract. `ViewportProjection` is ephemeral frontend state for the current
reader render, scroll root, viewport, font, zoom, PDF scale, and pane geometry.

## Goals

- One frontend-owned projection subsystem for visible reader-attached objects.
- One visibility definition for web articles, EPUBs, transcripts, and PDFs.
- The right secondary pane renders a highlight only when at least one rendered
  target rect intersects the primary reader viewport.
- Pane rows stay cross-column aligned with their visible source target while
  the user scrolls.
- Long highlights whose start anchor is offscreen still project from the
  visible highlighted segment.
- Overlapping highlights, linked note blocks, and linked conversations preserve
  the existing highlight interaction model.
- Reader typography changes, PDF zoom changes, image loads, pane resizing, and
  mobile chrome changes update projections without persisting pixels.
- Contextual visible-highlight presentation is separate from any all-highlights
  notebook/list surface.
- Missing or unprojectable anchors fail closed: no contextual row appears.
- Tests treat stale rows, offscreen rows, misaligned rows, and missing reflow
  updates as correctness failures.

## Non-Goals

- Do not change the durable saved-highlight storage model.
- Do not replace the evidence locator resolver.
- Do not change note-block or object-link ownership.
- Do not add server APIs for viewport visibility, scroll position, pane layout,
  or pixel coordinates.
- Do not persist DOM rects, scroll offsets, row positions, viewport state, or
  PDF rendered pixel coordinates.
- Do not make active section, active fragment, or active PDF page sufficient for
  secondary-pane visibility.
- Do not add a second all-highlights sidebar as part of this cutover.
- Do not implement collaborative cursors, multiplayer annotation presence, or
  comment-resolution workflows.
- Do not introduce a third-party positioning engine for the core projection
  loop.
- Do not keep legacy code paths for browsers without `ResizeObserver`.
  Unsupported browser primitives are a hard unsupported-reader state, not a
  silent fallback.

## Final State

All reader-attached secondary pane rows are driven by rendered target rects in
the reader scroll root.

- Text readers render saved and temporary highlights into the document with the
  existing `data-active-highlight-ids`, `data-highlight-top`, and
  `data-highlight-anchor` attributes.
- PDF readers keep page-local quads and page viewport transform metadata as the
  projection source for the secondary pane.
- `AnchoredHighlightsRail` measures rendered text segments and PDF quads into
  scroll-root coordinates.
- The right secondary pane renders only highlights with a measured rect that
  intersects the primary reader viewport.
- Row collision layout solves presentation overlap without changing projection
  truth.
- Clicking a row focuses the highlight and scrolls the primary reader until the
  target is visible.
- Clicking a highlighted source target focuses the corresponding row only when
  that row is visible in the contextual pane.
- Offscreen focused highlights remain focused in source, but their contextual
  pane row disappears.
- The contextual pane is not the notebook/all-highlights surface.

## Target Behavior

### Visibility

- A highlight is visible in the contextual secondary pane only when at least one
  rendered target rect intersects the primary reader viewport.
- The primary reader viewport is the scrollable pane content area after applying
  reader scroll padding, mobile document chrome reservation, safe-area inset,
  and PDF viewer clipping.
- Active fragment, active EPUB section, active transcript fragment, and active
  PDF page are loading scopes only. They are not visibility scopes.
- A long highlight whose zero-width start anchor is above the viewport appears
  when a highlighted text segment is visible.
- A multi-rect PDF highlight appears when at least one projected quad rect is
  visible.
- If a highlight has multiple visible rects, the alignment target is selected in
  this order:
  1. The first rect whose vertical center is inside the viewport.
  2. The rect with the largest visible intersection area.
  3. The first intersecting rect in document order.
- Above and below counts are navigation metadata. They do not cause offscreen
  rows to render.
- A missing anchor, detached DOM node, stale PDF transform, or failed projection
  produces no row and emits a typed development warning.

### Alignment

- Row placement uses the selected visible target rect, not the durable anchor's
  saved offsets.
- The row's visual top is aligned to the same horizontal scanline as the target
  rect in the primary reader pane.
- During scroll, projection updates run in one `requestAnimationFrame` tick per
  scroll frame.
- Layout reads are batched before layout writes.
- The row collision solver is deterministic:
  1. Sort visible projections by target top, document order, created timestamp,
     then id.
  2. Place each row at its desired top.
  3. Push overlapping rows downward by the minimum row gap.
  4. Compact rows only inside the visible secondary pane bounds.
  5. Represent rows that cannot fit with an in-view overflow control.
- Collision displacement is presentation. It does not modify projection state.

### Scroll and Reflow

- Projection state is recalculated when the reader scrolls.
- Projection state is recalculated when the reader root, target element,
  side-pane container, or row content resizes.
- Projection state is recalculated after images load or fail inside text
  readers.
- Projection state is recalculated after PDF page render, zoom, rotation, page
  change, highlight refresh, or temporary-highlight projection.
- Projection state is recalculated after reader theme, font family, font size,
  line height, or column width changes.
- Projection state is discarded when the active media item or active rendered
  document identity changes.

### Focus and Interaction

- Source click, row click, hover, keyboard focus, edit bounds, color change,
  delete, linked-note editing, and send-to-chat all use highlight ids as the
  shared identity.
- Hovering a row outlines all rendered source segments for that highlight.
- Hovering a source highlight emphasizes its row only when the row exists in the
  contextual pane.
- Clicking a row scrolls the primary reader to the selected target, focuses the
  highlight, and lets projection publish the row position after scroll settles.
- Clicking an offscreen all-highlights item is out of scope for this contextual
  pane. A future notebook surface must navigate through reader deep links.
- Focus reconciliation after refetch preserves the current highlight only if the
  highlight still exists.
- Editing highlight bounds updates the durable anchor, then invalidates
  projections from the new rendered source.

### PDF

- PDF durable anchors remain page-local geometry selectors.
- PDF projection uses one viewport transform source for overlay rendering and
  side-pane projection.
- PDF active page loading does not make every page highlight visible in the
  secondary pane.
- A highlight on the current PDF page but scrolled above or below the PDF viewer
  viewport is absent from the secondary pane.
- PDF temporary answer highlights use the same projection channel as saved PDF
  highlights and remain visually distinct.
- If PDF geometry is unavailable or stale, the contextual pane does not invent a
  position from quote text.

### Text Readers

- Web article, EPUB, and transcript highlights project from rendered highlight
  segments selected by `data-active-highlight-ids~="{highlightId}"`.
- `data-highlight-anchor` remains useful for deterministic scroll-to-start and
  for missing-anchor diagnostics, but it is not the only projection target.
- Canonical offsets remain the durable text anchor.
- DOM rects derived from rendered text are ephemeral and never persisted.
- EPUB section changes invalidate previous section projection rects before new
  section rows render.

### Contextual Pane Copy

- The pane title and description describe viewport context, not section or page
  context.
- Desktop and mobile copy use the same visibility meaning.
- Empty visible state says no highlights are in view, not that the section or
  page has no highlights.

## Architecture

### Pane-Owned Projection

The subsystem lives in
`apps/web/src/components/reader/AnchoredHighlightsRail.tsx`.
This keeps the single projection consumer, row presentation, measurement loop,
and collision layout in one file with direct control flow.

`AnchoredHighlightsRail` owns:

- Scroll-root discovery.
- Text target discovery from `data-active-highlight-ids`.
- PDF target construction from page-space quads and page viewport transforms.
- Scroll-space target rect storage.
- Viewport intersection filtering.
- Desktop row alignment and collision layout.
- Mobile visible rows plus above and below counts.
- Missing-target diagnostics.

`MediaPaneBody` owns route-level composition, DTO shaping, and copy. It does
not measure DOM or compute row positions.

`PdfReader` continues to own PDF rendering, page loading, highlight fetching,
overlay rendering, and page transform metadata.

### State Ownership

- Durable highlight state stays in `MediaPaneBody` and existing API helpers.
- Projection rect state lives inside `AnchoredHighlightsRail`.
- Focus state stays in the existing highlight interaction path.
- Reader resume state stays in `useReaderResumeState`.
- PDF controls state stays in `PdfReader`.

No code path persists projection rects, viewport positions, or row positions.

## Rules

- Treat durable anchors and viewport projections as different types.
- Never persist projection state.
- Never use active fragment, active section, or active page as a proxy for
  viewport visibility.
- Never render a contextual row for an offscreen target.
- Never clamp an offscreen-above row to the top of the side pane.
- Never infer PDF side-pane position from quote text when geometry is absent.
- Never let row collision layout change source focus or durable ordering.
- Use one scroll root per reader projection pass.
- Use browser resize observation and a single animation-frame scroll loop for
  scroll-coupled alignment.
- Fail closed on missing anchors, stale nodes, unsupported browser primitives,
  and invalid transforms.
- Keep all selectors token-safe with `CSS.escape` for highlight ids.
- Keep accessibility state attached to rows that are actually rendered.

## Files

### Add

- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsRail.test.tsx`

### Change

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`

### Delete

- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/LinkedItemsPane.module.css`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`

`MediaPaneBody.tsx` keeps route-level composition ownership. It does not own
measurement, projection, or layout.

## Key Decisions

- Visibility is based on rendered target rect intersection, not data loading
  scope.
- Text projection uses highlighted segment rects, not only zero-width anchor
  markers.
- PDF projection uses page-space geometry through the same transform used by
  overlay rendering.
- Projection state is frontend-only and ephemeral.
- Contextual visible-highlight panes and all-highlight notebook/list panes are
  separate products.
- `AnchoredHighlightsRail` owns coordinate conversion, visibility, and row
  collision layout.
- The cutover deletes legacy measurement code instead of wrapping it.

## Implementation Plan

### Phase 1: Component Cutover

- Replace `LinkedItemsPane` with `AnchoredHighlightsRail`.
- Keep row presentation local to the pane.
- Remove legacy desktop alignment and mobile-only visibility filtering.

### Phase 2: Text Reader Adapter

- Build target discovery from `data-active-highlight-ids`.
- Keep `data-highlight-anchor` for scroll-to-start and diagnostics.
- Measure rendered segment rects into scroll-root coordinates.
- Treat zero-width anchors without rendered segments as missing targets.

### Phase 3: PDF Adapter

- Ensure overlay rendering and side-pane projection use one transform source.
- Project page-space quads into scroll-root coordinates.
- Keep the existing PDF active-page fetch path as the loading scope.
- Preserve PDF highlight creation, color, delete, focus, temporary answer
  highlight, and quote-to-chat behavior.

### Phase 4: Pane Cutover

- Update copy to describe viewport-visible highlights.
- Render desktop and mobile rows only from visible target rects.
- Keep above and below controls as navigation metadata only.

### Phase 5: Verification and Cleanup

- Delete removed component files and tests that assert old section/page scoped
  behavior.
- Add browser component coverage for text, PDF, desktop, mobile, anchor-only,
  scroll, and ordering behavior.
- Run the focused browser component test and frontend static checks.

## Acceptance Criteria

- Desktop web reader shows a row only for highlights whose rendered text
  intersects the primary reader viewport.
- Desktop EPUB reader shows a row only for highlights whose rendered section
  text intersects the primary reader viewport.
- Desktop transcript reader shows a row only for highlights whose rendered
  transcript text intersects the primary reader viewport.
- Desktop PDF reader shows a row only for highlights whose projected PDF rect
  intersects the PDF viewer viewport.
- A highlight on the active EPUB section but above the viewport is absent from
  the secondary pane.
- A highlight on the active PDF page but below the viewport is absent from the
  secondary pane.
- A long highlight whose start marker is offscreen appears when a highlighted
  segment is visible.
- Rows move in alignment with source targets during scroll without sticking to
  the top or bottom when the source target leaves the viewport.
- Rows re-align after font size, line height, column width, PDF zoom, pane
  resize, and image load changes.
- Clicking a visible row scrolls and focuses the source highlight.
- Clicking a source highlight focuses the row when the row is visible.
- Hovering a row outlines all source segments for that highlight.
- Deleting or recoloring a highlight invalidates projection and preserves focus
  only when the highlight still exists.
- Missing anchors do not render rows.
- No active app code imports `LinkedItemsPane`.
- No active app code computes secondary-pane row positions outside the anchored
  projection subsystem.
- `rg "LinkedItemsPane" apps/web/src` returns only deleted-file history or no
  active references.
- `make check`, `make test-front-browser`, targeted reader E2E tests, and
  `make verify` pass.

## Test Plan

- Browser component tests cover text visibility, PDF quad projection, desktop
  scroll filtering, mobile scroll filtering, anchor-only missing targets,
  ordering, linked notes, linked chats, color actions, delete actions, and
  shared-reader note behavior.
- Browser component tests use real DOM measurement behavior where text layout
  matters and explicit rect mocks where viewport placement is the assertion.
- E2E tests cover web article, EPUB, transcript, PDF, and mobile drawer
  behavior through visible UI.
- E2E tests normalize reader state before assertions.
- E2E tests assert visible row presence, row absence for offscreen targets,
  source focus after row click, row focus after source click, and alignment
  tolerance during scroll.

## Risks

- PDF.js render timing can publish transforms before overlay nodes exist. The
  PDF adapter must invalidate projection after page render and after overlay
  layer attachment.
- Long text highlights can produce many DOM rects. The text adapter must batch
  measurement and cap repeated work to one projection pass per frame.
- Collision layout can hide useful rows if many visible highlights crowd a small
  pane. The overflow control must be explicit and deterministic.
- Existing tests that assume section-scoped or page-scoped row presence must be
  rewritten as viewport-scoped assertions.
- Browser API absence is a hard unsupported state. The product must decide
  whether the supported browser matrix excludes those environments before the
  cutover lands.
