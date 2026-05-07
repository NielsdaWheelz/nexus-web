# Reader Gutter Marginal Rail Hard Cutover

## Status

Implemented target.

This document supersedes the collapsed-gutter heatmap target in
`docs/reader-secondary-rail-hard-cutover.md` and
`docs/visual-refactor-1b-hard-cutover.md`.

The minimized highlight pane is no longer a document-wide heatmap. It is a
viewport-attached marginal rail that renders compact markers on the same
horizontal scanlines as the visible highlighted source text.

## Role

This document owns the collapsed highlight gutter for reader surfaces:

- web articles
- EPUB sections
- transcripts
- PDFs

It does not own the expanded highlights pane row UI, Ask mode, durable
highlight storage, highlight creation, or note editing.

The cutover is hard. The final state keeps no heatmap positioning path, no
document-percent tick calculations, no scroll-height based text gutter
positions, no active-fragment/page positioning fallback, no old/new gutter
branch, no feature flag, no compatibility wrapper, and no legacy tests that
assert document-wide gutter ticks.

## Problem

The existing `ReaderGutter` text path computes each tick as a percentage of the
reader scroll container's full `scrollHeight`:

```text
highlight DOM rect -> scroll-root offset -> topPercent -> absolute top %
```

That made sense for a heatmap, but it is the wrong product model for a
minimized contextual highlight pane.

The observed failure mode is that newly-created text highlights can resolve to
the same near-zero position and then cluster at the top of the gutter. The
marker exists, but it is visually invisible because it overlaps other markers
and is not scanline-aligned to its source text.

## Goals

- Convert the collapsed gutter into a scanline-aligned marginal highlight rail.
- Use the same rendered-target projection semantics as `AnchoredHighlightsRail`.
- Keep expanded and collapsed highlight surfaces consistent about visibility.
- Render collapsed markers only for highlights with visible reader targets.
- Align each marker to the selected visible target rect in the reader viewport.
- Update marker positions in one animation-frame pass per scroll frame.
- Recompute projection after reader layout, typography, image, PDF, and rail
  geometry changes.
- Remove scroll-height percentage positioning for text, transcript, EPUB, and
  PDF gutters.
- Keep durable highlight data separate from frontend projection state.
- Keep the collapsed UI compact and fast: markers, expand affordance, hover
  preview, click-to-focus.

## Non-Goals

- Do not keep a document-wide highlight heatmap in the collapsed gutter.
- Do not render offscreen highlights in the collapsed gutter.
- Do not add a separate minimap, scrollbar overlay, or all-highlights notebook.
- Do not change saved highlight APIs or durable anchor formats.
- Do not add backend APIs for viewport visibility, DOM rects, PDF pixels, or
  scroll state.
- Do not persist marker positions, DOM rects, viewport state, or row positions.
- Do not use active fragment, active EPUB section, active transcript segment, or
  active PDF page as a proxy for collapsed-gutter visibility.
- Do not mount the full expanded rail UI inside the collapsed gutter.
- Do not introduce a third-party positioning engine for this projection loop.

## Final State

The reader has one anchored highlight projection subsystem.

```text
DurableHighlight
  -> RenderedHighlightTarget
      -> VisibleHighlightProjection
          -> ExpandedAnchoredRows
          -> CollapsedMarginalMarkers
```

- `AnchoredHighlightsRail` renders expanded rows from visible projections.
- The collapsed gutter renders compact markers from visible projections.
- Both surfaces use the same target discovery and visible-rect selection rules.
- The expanded rail solves row collisions for readable row cards.
- The collapsed gutter clusters only markers that truly share or nearly share a
  visible scanline.
- The old heatmap contract is deleted.

## Target Behavior

### Desktop Collapsed

1. Opening readable media shows the reader plus a collapsed right marginal rail.
2. The rail shows markers only for highlights visible in the reader viewport.
3. Each marker is vertically aligned with the selected visible source target
   rect.
4. Scrolling the reader moves markers with the source text in the same
   animation frame.
5. A highlight leaving the viewport disappears from the collapsed rail.
6. A highlight entering the viewport appears at its source scanline.
7. Clicking a marker focuses the highlight, scrolls/pulses the source target
   when needed, and preserves the existing reader-pulse contract.
8. Hovering or focusing a marker shows the existing compact hover preview.
9. Activating the expand affordance opens the same secondary rail in
   `Highlights` mode.

### Desktop Expanded

The expanded rail remains the authoritative full row surface.

1. Rows render only for visible highlight projections.
2. Rows align to the same selected target rect used by collapsed markers.
3. Rows keep notes, Ask, actions, linked conversations, and collision layout.
4. Expanding the rail does not change highlight visibility semantics.
5. Collapsing the rail returns to the marginal marker surface without changing
   focus or durable highlight state.

### Mobile

Mobile uses the same projection semantics.

1. The mobile collapsed gutter shows visible scanline-aligned markers only.
2. Mobile expanded highlights continue to use the local drawer.
3. The drawer renders visible contextual rows and above/below navigation
   metadata.
4. Mobile does not render a persistent expanded secondary rail.

### Empty And Offscreen States

- A document with saved highlights but none visible renders an empty collapsed
  marker layer.
- Offscreen highlights are not clamped to the top or bottom of the gutter.
- Missing or unprojectable highlights do not render markers.
- Above/below counts belong to expanded/mobile contextual row surfaces, not to
  the collapsed marker layer.

## Structure

### Projection Core

Extract the projection logic currently embedded in `AnchoredHighlightsRail` into
a shared reader module:

- target ordering
- scroll-root discovery
- text target discovery
- PDF target projection
- viewport state
- visible rect selection
- missing-target diagnostics
- scroll and resize invalidation

Suggested module:

- `apps/web/src/components/reader/useAnchoredHighlightProjection.ts`

The module returns visible projections, not UI:

```ts
interface AnchoredHighlightProjection {
  highlight: AnchoredHighlightRow;
  rect: { top: number; bottom: number };
  targetTop: number;
  targetBottom: number;
  viewportTop: number;
  viewportBottom: number;
  target: ReaderPulseTarget;
}
```

The exact shape can differ, but it must preserve the separation between durable
highlight data and ephemeral viewport projection.

### Expanded Rail

`AnchoredHighlightsRail` becomes a consumer of the shared projection module.

It still owns:

- row rendering
- note editors
- Ask/action controls
- linked conversations
- row height measurement
- desktop row collision layout
- mobile visible-row presentation
- row overflow affordance

It no longer owns the only copy of target discovery or projection state.

### Collapsed Gutter

Replace the old heatmap implementation with an anchored gutter implementation.

Allowed final naming:

- keep `ReaderGutter` as the collapsed reader-gutter component name, or
- rename it to `AnchoredHighlightsGutter` and update all imports.

Either way, the old heatmap code is deleted. There is no compatibility wrapper.

The collapsed gutter owns:

- expand affordance
- compact marker rendering
- marker clustering
- hover preview anchoring
- marker activation
- marker accessibility labels

It does not own target discovery, PDF coordinate transforms, durable highlight
state, row rendering, note editing, or Ask state.

### Composition

`MediaPaneBody` owns route-level composition:

- collapsed vs expanded rail state
- `Highlights` vs `Ask` rail mode
- reader assistant state
- highlight DTO shaping
- source refs passed into projection consumers
- mobile drawer/sheet composition

It does not compute DOM rects, marker positions, row positions, or visibility.

`SecondaryRail` remains layout-only.

## Architecture

### Shared Projection Contract

The shared projection module accepts:

- ordered highlight DTOs
- media kind
- media id
- reader content ref
- PDF page metadata when needed
- measurement key
- mobile/desktop mode only when it affects viewport chrome

The projection module produces:

- visible projections
- missing target ids for development diagnostics
- viewport state
- a schedule/refresh mechanism internal to the hook

The projection module must not render UI.

### Coordinate Spaces

Use scroll-root coordinates as the shared truth.

For text readers:

```text
segment client rect
  -> rect.top - scrollRootRect.top + scrollRoot.scrollTop
  -> scroll-root rect
```

For PDF readers:

```text
page quad
  -> page viewport transform
  -> page client rect
  -> scroll-root rect
```

For collapsed marker placement:

```text
projection rect in scroll-root coordinates
  -> projection rect top - viewport scrollTop
  -> marker-layer pixel top
```

The marker layer must be aligned to the reader viewport. The expand affordance
must not push the marker coordinate system downward. It can be overlaid, or the
reader viewport and marker layer can share an identical inset. A marker at the
top visible text scanline must not be displaced by the expand button's height.

### Visibility

A highlight is visible when at least one rendered target rect intersects the
reader viewport.

Use the existing visible-rect selection order:

1. First rect whose vertical center is inside the viewport.
2. Rect with the largest visible vertical intersection.
3. First intersecting rect in document order.

This rule is shared by expanded rows and collapsed markers.

### Marker Clustering

Collapsed markers may cluster only after a valid visible projection exists.

Rules:

- Cluster by pixel proximity in the marker layer, not by document percentage.
- Cluster only markers whose projected scanlines would visually overlap.
- A cluster's position is derived from its member projections, not from a
  fallback default.
- Cluster activation targets the primary member by deterministic order.
- Hover preview lists all clustered snippets.
- Missing/unprojectable highlights never join a top cluster.

### Scroll And Reflow

Projection updates run through the shared module.

Recalculate when:

- reader scrolls
- reader content changes
- highlight list changes
- temporary highlight changes
- reader font family, font size, line height, column width, or theme changes
- EPUB section changes
- transcript content changes
- PDF page render, zoom, rotation, or highlight refresh changes
- image load or error fires inside text content
- reader viewport, collapsed gutter, expanded rail, or row container resizes

During scroll, use one `requestAnimationFrame` pass per frame. Batch layout
reads before layout writes.

## Rules

- One projection subsystem owns target discovery and viewport intersection.
- Durable anchors are product data; viewport projections are ephemeral frontend
  state.
- Never persist DOM rects, PDF pixel rects, marker positions, row positions, or
  viewport state.
- Never use scroll-height percentage positioning in the collapsed gutter.
- Never render a collapsed marker for an offscreen source target.
- Never clamp an offscreen marker to the top or bottom of the gutter.
- Never use active loading scope as visibility.
- Never infer PDF marker position from quote text when geometry is unavailable.
- Never query live DOM for marker positions during render.
- Measure after commit through layout/effect work scheduled by the shared
  projection module.
- Use `getClientRects()` for text targets and ignore zero-area rects.
- Use `CSS.escape` for all highlight ids in selectors.
- Keep `data-highlight-anchor` for deterministic navigation and diagnostics; do
  not use it as the only text projection target.
- Unsupported browser primitives such as missing `ResizeObserver` are
  unsupported-reader defects, not silent fallback modes.
- Delete old tests that assert document-wide heatmap behavior.

## Files

### Add

- `apps/web/src/components/reader/useAnchoredHighlightProjection.ts`

Optional, if the gutter is renamed instead of rewritten in place:

- `apps/web/src/components/reader/AnchoredHighlightsGutter.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsGutter.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsGutter.test.tsx`

### Change

- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsRail.test.tsx`
- `apps/web/src/components/reader/ReaderGutter.tsx`
- `apps/web/src/components/reader/ReaderGutter.module.css`
- `apps/web/src/components/reader/ReaderGutter.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `docs/reader-secondary-rail-hard-cutover.md`
- `docs/visual-refactor-1b-hard-cutover.md`

### Delete

Delete these concepts from active code:

- `computeFragmentTopPercent`
- `computePdfTopPercent`
- `computeTranscriptTopPercent`
- `CLUSTER_BUCKET_PERCENT`
- scroll-height percentage gutter positioning
- document-wide gutter heatmap tests

If renaming the component, also delete:

- `apps/web/src/components/reader/ReaderGutter.tsx`
- `apps/web/src/components/reader/ReaderGutter.module.css`
- `apps/web/src/components/reader/ReaderGutter.test.tsx`

Do not keep a wrapper under the old component name.

## Key Decisions

- The collapsed gutter is a viewport marginal rail, not a document heatmap.
- `AnchoredHighlightsRail` is not mounted directly inside the collapsed gutter.
  Its projection logic is extracted and reused.
- Expanded and collapsed highlight surfaces share visibility and target
  selection semantics.
- Collapsed markers are positioned in pixels against the reader viewport, not in
  percentages against the full document.
- The expand affordance is outside the marker coordinate system.
- Offscreen highlight overview is not part of the collapsed gutter.
- Missing target behavior fails closed.
- PDF gutter positioning uses geometry, never quote text.
- The cutover removes the old implementation instead of branching around it.

## Implementation Plan

### Phase 1: Extract Projection

- Move scroll-root discovery, text measurement, PDF projection, visible-rect
  selection, missing-target diagnostics, and invalidation scheduling out of
  `AnchoredHighlightsRail`.
- Preserve existing expanded rail behavior while swapping it to the shared hook.
- Keep row collision layout in `AnchoredHighlightsRail`.

### Phase 2: Replace Collapsed Gutter Positioning

- Remove document-percent tick calculations.
- Render markers from visible projections.
- Align the marker layer to the reader viewport.
- Move the expand affordance out of the marker coordinate flow.
- Cluster only valid visible projections that visually overlap.

### Phase 3: Wire All Reader Kinds

- Web and EPUB use rendered `data-active-highlight-ids` segment rects.
- Transcript uses the same rendered highlight segment path when rendered as text.
- PDF uses page geometry and viewport transform metadata.
- Mobile collapsed gutter uses the same projection path.

### Phase 4: Delete Legacy Contracts

- Delete heatmap helpers and tests.
- Update docs that describe the collapsed gutter as document-wide.
- Ensure no code path computes collapsed gutter positions from scrollHeight
  percentages.

### Phase 5: Verification

- Add browser component coverage for text marker alignment after highlight list
  mutation.
- Add browser component coverage for scroll enter/exit behavior.
- Add browser component coverage for marker clustering from real projections.
- Add PDF projection coverage where rect mocks or page transforms are stable.
- Run focused browser component tests and frontend static checks.

## Acceptance Criteria

- Creating a new visible text highlight immediately renders a collapsed marker at
  the highlighted text's scanline.
- Newly-created visible highlights do not cluster at the top unless their source
  targets are actually at the top visible scanline.
- Scrolling a visible highlight down moves its collapsed marker down in the same
  frame.
- Scrolling a highlight out of view removes its collapsed marker.
- Scrolling a highlight into view adds its collapsed marker at the correct
  scanline.
- A saved offscreen highlight does not render a collapsed marker.
- A missing text target does not render a collapsed marker and emits the existing
  typed development diagnostic.
- A long text highlight with an offscreen start anchor renders a marker when any
  highlighted segment is visible.
- Overlapping highlights render a deterministic marker cluster at the visible
  projected scanline.
- Clicking a marker dispatches the reader pulse target for the corresponding
  highlight.
- Hovering a marker shows the correct snippet preview.
- Expanding the rail shows rows for the same visible highlights represented by
  collapsed markers.
- Collapsing the rail returns to the same marker projection semantics.
- PDF markers align to visible projected quads.
- PDF highlights with missing or stale geometry do not render collapsed markers.
- The expand button does not offset marker placement.
- `rg "computeFragmentTopPercent|computePdfTopPercent|computeTranscriptTopPercent|CLUSTER_BUCKET_PERCENT" apps/web/src`
  returns no active implementation.
- No active test asserts document-wide collapsed heatmap ticks.
- Focused browser component tests, reader E2E coverage, frontend static checks,
  and the repo's required verification command pass.

## Test Plan

- Collapsed gutter browser component tests cover marker top alignment in pixels,
  scroll updates, highlight-list mutation, clustering, hover preview, click
  activation, and expand activation.
- Expanded rail tests prove rows and collapsed markers consume the same visible
  projection set.
- E2E tests create a real text highlight from a visible selection and assert the
  collapsed marker appears at the same scanline.
- E2E tests scroll the reader and assert markers enter and leave with the source
  text.
- PDF E2E or component tests assert visible-quad marker placement and missing
  geometry fail-closed behavior.

## Risks

- The current gutter layout reserves vertical space for the expand button. That
  will misalign markers unless the marker layer becomes full-height or shares
  the same inset as the reader viewport.
- Sharing projection state incorrectly could couple row collision layout to
  marker rendering. The hook should expose source projections only; row layout
  remains a consumer concern.
- Text layout can change after images load. The shared projection module must
  retain image load/error invalidation.
- PDF page transforms can be temporarily stale during zoom or rotation. Projection
  must fail closed until fresh transform metadata is available.
- Tests that run outside the browser project may not exercise layout. Alignment
  assertions need browser component or E2E coverage.
