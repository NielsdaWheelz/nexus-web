# Reader Secondary Rail Hard Cutover

## Status

Implemented target.

The codebase contains the hard-cutover pieces:

- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/components/reader/ReaderGutter.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/highlights/HighlightColorPicker.tsx`
- `apps/web/src/components/reader/HighlightActionsMenu.tsx`
- `MediaPaneBody` composition that mounts the collapsed gutter, expanded
  contextual highlights rail, and Ask rail mode

## Role

This document owns desktop reader-adjacent secondary rails for media panes:

- collapsed highlight gutter
- expanded contextual highlights rail
- reader Ask rail mode

It supersedes the desktop highlight slide-over and desktop reader-chat overlay
targets from `docs/visual-refactor-1b-hard-cutover.md`. Mobile keeps local
drawers and sheets.

The cutover is hard. The final state keeps no desktop highlights slide-over, no
desktop reader-chat slide-over, no all-highlights list in the reader rail, no
legacy row-disclosure behavior, no feature flag, no fallback branch, and no
backward-compatible wrapper for removed APIs.

## Implementation State

The current implementation is aligned with this target:

- `SecondaryRail` exists and owns collapsed/expanded rail layout.
- `ReaderGutter` exists and remains the collapsed right-edge highlight surface.
- `AnchoredHighlightsRail` exists and measures rendered highlight targets into
  scroll-root coordinates.
- `MediaPaneBody` already composes `SecondaryRail`, `ReaderGutter`,
  `AnchoredHighlightsRail`, and `ReaderAssistantPane`.
- `HighlightColorPicker` is shared by `SelectionPopover` and highlight row
  actions.
- `HighlightActionsMenu` owns edit-bounds, color, and delete row actions.
- Highlight rows render full context, visible Ask/actions, inline notes, and
  linked conversations without a disclosure click.
- Desktop source refs to `HighlightsInspectorOverlay`,
  `ReaderChatOverlay`, `MediaHighlightsPaneBody`, and `mediaHighlightOrdering`
  are gone.

## Goals

- Keep the persistent gutter as the collapsed reader highlight overview.
- Expand the gutter into a stable desktop secondary rail, not a modal overlay.
- Make `Highlights` and `Ask` sibling modes in the same media-local rail.
- Render `Highlights` rows only from viewport-visible reader projections.
- Align each contextual row to its visible source target while the reader
  scrolls.
- Make each row content-first: full context text first, selected span marked.
- Keep Ask, actions, notes, and linked chats immediately visible without a row
  expansion click.
- Reuse one highlight color picker component in selection popovers and highlight
  action menus.
- Keep durable highlight storage separate from viewport projection state.
- Preserve mobile drawer/sheet behavior without adding a persistent mobile rail.

## Non-Goals

- Do not build an all-highlights notebook or library-wide highlight browser.
- Do not change durable saved-highlight storage or API semantics.
- Do not add backend APIs for viewport visibility, DOM rects, row positions, or
  scroll state.
- Do not change evidence resolver ownership of citation navigation.
- Do not redesign the global workspace pane runtime.
- Do not remove normal full conversation panes or explicit full-chat promotion.
- Do not make mobile use a persistent secondary rail.
- Do not prefetch every PDF page highlight solely to fill a contextual rail.
- Do not keep old inspector/list files as compatibility paths.

## Hard-Cutover Policy

- No feature flags.
- No environment toggles.
- No query toggles.
- No old/new component branches.
- No duplicate tests for removed behavior.
- No fallback from media Ask or media Highlights to opening a workspace pane.
- No hidden legacy all-highlights list inside the reader rail.
- No backward-compatible wrappers around removed overlay APIs.
- Delete or rewrite tests that assert the removed overlay or row expansion.
- Update docs that describe desktop reader overlays as the active target.

## Final State

Desktop media panes have one reader-local secondary rail.

- Collapsed: a 36px gutter remains visible at the reader's right edge.
- Expanded: the rail occupies layout space and reflows the reader column.
- Modes: `Highlights` and `Ask`.
- `Highlights`: contextual, viewport-visible, anchored rows.
- `Ask`: `ReaderAssistantPane` hosted in the same rail.
- Closing/collapsing the rail returns to the gutter.

Mobile media panes do not use the persistent rail.

- The gutter remains the compact highlight affordance where currently supported.
- Expanded highlights use a local drawer.
- Ask uses the existing mobile reader assistant sheet.

The contextual highlights rail is not an all-highlights surface.

- Offscreen highlights remain durable data but do not render.
- Active EPUB section, active fragment, active transcript segment, and active PDF
  page are loading scopes only. They are not visibility scopes.
- Missing or unprojectable targets fail closed and render no row.

## Target Behavior

### Desktop Collapsed

1. Opening readable media shows the reader plus a collapsed right gutter.
2. The gutter shows one tick or cluster per known highlight.
3. Clicking a tick scrolls and pulses the source highlight.
4. Clicking the gutter expand affordance opens the rail in `Highlights` mode.
5. The reader column reflows; no backdrop appears and the reader remains
   scrollable.

### Desktop Highlights Mode

1. Rows appear only when at least one source target rect intersects the reader
   viewport.
2. Rows align vertically with the selected visible source target rect.
3. Scrolling the reader updates row visibility and row alignment in a single
   animation-frame pass.
4. Reflow from reader typography, image load, EPUB section changes, PDF render,
   PDF zoom, note edits, rail resize, and highlight mutation invalidates
   projections.
5. Rows never clamp offscreen highlights into view.
6. Collisions are solved by row placement, not by changing projection truth.
7. Overflow inside the visible rail is represented by an in-view overflow
   affordance.

### Row Presentation

Each row is always expanded in the old sense. There is no disclosure state.

The row shows, in order:

1. A full context snippet: prefix, exact selection, suffix.
2. The exact selection marked with the highlight color.
3. Visible row actions: Ask and menu when allowed.
4. Inline note editor.
5. Linked conversations when present.

Rules:

- Rows are left-aligned.
- No separate highlight color swatch renders in the row.
- No compact exact-only preview renders in the row.
- No note/chat metadata badges replace visible content.
- The note editor has no visible textbox outline in its resting state.
- Note text uses compact body sizing and cannot be visually louder than the
  selected quote.
- A row content click scrolls the reader to the highlight target.
- Ask, menu, color, delete, edit-bounds, note editing, and linked conversation
  controls stop their own clicks and do not trigger row navigation.

### Source Highlight Clicks

Clicking highlighted text in the reader is not a disclosure action.

- It may focus the highlight for visual sync and overlap cycling.
- It may emphasize the visible row if the rail is open and the row exists.
- It does not open the rail.
- It does not reveal hidden controls because no controls are hidden.
- It does not switch to Ask.

### Ask Mode

1. Selecting text and invoking Ask expands the rail if needed.
2. The rail switches to `Ask`.
3. The selected quote is attached as pending reader-selection context.
4. The composer is focused without changing the active workspace pane.
5. Asking from a saved highlight row attaches that highlight as object-ref
   context and switches the same rail to `Ask`.
6. Full chat opens only through explicit promotion after a conversation exists.

### Mobile

1. Mobile never renders a persistent secondary rail.
2. Expanded highlights use the local drawer.
3. Ask uses the local sheet.
4. The mobile drawer still renders only visible contextual rows and above/below
   navigation metadata.

## Architecture

### `SecondaryRail`

`SecondaryRail` owns layout only:

- collapsed width
- expanded width
- collapsed slot
- header and tab slot
- body slot
- expand/collapse callback
- overflow and border styling

It does not know about highlights, chat, reader contexts, PDF, EPUB, notes,
workspace routing, or conversations.

### `MediaPaneBody`

`MediaPaneBody` owns route-local media rail state:

- `secondaryRailMode`
- `isSecondaryRailExpanded`
- reader assistant state
- pending reader-selection contexts
- saved-highlight Ask contexts
- full-chat promotion
- highlight DTO shaping for `AnchoredHighlightsRail`
- collapsed gutter composition
- mobile drawer/sheet composition

It does not measure DOM rects or solve row placement.

### `AnchoredHighlightsRail`

`AnchoredHighlightsRail` owns highlight projection and contextual row layout:

- text target discovery from `data-active-highlight-ids`
- PDF target discovery from page geometry and viewport transforms
- scroll-root discovery
- visible target rect selection
- viewport filtering
- missing-target diagnostics
- row collision layout
- overflow affordance
- row hover source outline
- row navigation to source target

Projection state is frontend-only and ephemeral.

### Shared Color Picker

Create one reusable highlight color picker component for all highlight color
selection UI.

The picker owns:

- color order from `HIGHLIGHT_COLORS`
- accessible labels from `COLOR_LABELS`
- selected/current color state
- disabled colors
- swatch geometry
- keyboard behavior

`SelectionPopover` and the highlight action menu both use this component. Neither
component maps `HIGHLIGHT_COLORS` into ad hoc swatch or text-menu markup.

### Highlight Action Menu

The row menu is a highlight-specific action popover, not a list of color text
items inside generic `ActionMenu`.

It owns:

- edit bounds / cancel edit bounds
- shared color picker
- delete
- disabled and pending state

The generic `ActionMenu` remains available for simple text action lists, but it
does not own highlight color selection.

## Projection Details

### Text Readers

- Measure rendered highlight segments with
  `[data-active-highlight-ids~="{escapedHighlightId}"]`.
- Use `CSS.escape` for highlight ids in all selectors.
- Derive rects from `getClientRects()` and ignore zero-area rects.
- Keep `data-highlight-anchor` for scroll-to-start diagnostics and navigation,
  not as the only projection target.
- A long highlight whose start anchor is offscreen appears when a rendered
  highlighted segment is visible.

### PDF Readers

- Use page-local quads plus the same viewport transform metadata used for PDF
  highlight overlay rendering.
- Do not infer row position from quote text.
- Do not render a row when page geometry or transform metadata is missing.
- Current active-page loading remains a loading concern, not a visibility rule.

### Visible Rect Selection

When a highlight has multiple visible rects, choose the alignment rect in this
order:

1. First rect whose vertical center is inside the viewport.
2. Rect with the largest visible intersection area.
3. First intersecting rect in document order.

### Row Collision

Desktop row placement is deterministic:

1. Sort by target top, stable document order, created timestamp, then id.
2. Place each row at its desired top.
3. Push overlapping rows downward by the minimum row gap.
4. Compact only inside the visible rail bounds.
5. Represent rows that cannot fit with an overflow affordance.

Collision displacement is presentation only. It never changes source focus,
projection state, durable order, or row identity.

## Rules

- Keep durable anchors and viewport projections as separate types.
- Never persist projection state.
- Never use active fragment, active EPUB section, active transcript segment, or
  active PDF page as a proxy for viewport visibility.
- Never render an offscreen contextual row.
- Never clamp an offscreen row to the top or bottom of the rail.
- Never invent PDF row positions from quote text.
- Use one scroll root per projection pass.
- Use one `requestAnimationFrame` per scroll frame.
- Batch layout reads before layout writes.
- Use `ResizeObserver`; unsupported primitives are unsupported-reader defects,
  not silent fallbacks.
- Use shared reader scroll-padding-aware navigation for row-to-source jumps.
- Keep row controls visible without row focus.
- Keep row content left-aligned.
- Keep row color visible only through the marked exact quote and color picker.
- Do not render a separate row swatch.
- Do not render a compact exact-only preview.
- Do not keep `rowExpanded`, `quoteCard`, `previewText`, or `colorSwatch` as
  final row concepts.

## Files

### Add

- `apps/web/src/components/highlights/HighlightColorPicker.tsx`
- `apps/web/src/components/highlights/HighlightColorPicker.module.css`
- `apps/web/src/components/highlights/HighlightColorPicker.test.tsx`
- `apps/web/src/components/reader/HighlightActionsMenu.tsx`
- `apps/web/src/components/reader/HighlightActionsMenu.module.css`
- `apps/web/src/components/reader/HighlightActionsMenu.test.tsx`

Optional only if row rendering becomes too large for `AnchoredHighlightsRail`:

- `apps/web/src/components/reader/AnchoredHighlightRowView.tsx`
- `apps/web/src/components/reader/AnchoredHighlightRowView.module.css`

### Change

- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
  - remove old preview/disclosure row model
  - render full context and visible controls for every visible row
  - use `HighlightActionsMenu`
  - use improved visible-rect selection
  - use padding-aware source navigation
  - keep projection and collision ownership
- `apps/web/src/components/reader/AnchoredHighlightsRail.module.css`
  - delete old row preview, swatch, quote-card, and expanded-state styles
  - add compact content-first row styles
  - add minimal inline note styles
- `apps/web/src/components/reader/AnchoredHighlightsRail.test.tsx`
  - cover visible rows, offscreen omission, full context, visible actions,
    visible note editor, row navigation, overflow, and color menu wiring
- `apps/web/src/components/SelectionPopover.tsx`
  - replace local color swatch loop with `HighlightColorPicker`
- `apps/web/src/components/SelectionPopover.module.css`
  - remove duplicated color picker styles
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
  - assert shared picker behavior remains intact
- `apps/web/src/lib/highlights/useHighlightInteraction.ts`
  - use escaped selectors
  - keep source click semantics focused on source/row sync, not disclosure
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - keep `SecondaryRail` composition
  - keep Ask and Highlights as local rail modes
  - route saved-highlight Ask through the rail
  - keep mobile drawer/sheet paths only for mobile
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
  - keep split reader plus rail layout
  - remove any styles that exist only for deleted overlays or old row states
- `docs/visual-refactor-1b-hard-cutover.md`
  - mark desktop highlights inspector and reader-chat overlay sections as
    superseded by this document

### Delete Or Verify Absent

- `apps/web/src/components/reader/HighlightsInspectorOverlay.tsx`
- `apps/web/src/components/reader/HighlightsInspectorOverlay.module.css`
- `apps/web/src/components/chat/ReaderChatOverlay.tsx`
- `apps/web/src/components/chat/ReaderChatOverlay.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlightOrdering.ts`
- tests and screenshots that assert the deleted overlay or row expansion behavior

## Implementation Plan

### Phase 1: Lock The Rail Contract

- Keep `SecondaryRail` as the only desktop reader rail primitive.
- Verify no desktop overlay imports or files remain.
- Rename tests and test ids away from `linked-item` terminology where practical.
- Update docs that still describe desktop slide-over behavior.

### Phase 2: Shared Color Picker

- Extract `HighlightColorPicker` from `SelectionPopover` behavior.
- Replace `SelectionPopover` local swatches with the shared picker.
- Add `HighlightActionsMenu` and use the same picker for highlight color changes.
- Remove text color menu items from the row action path.

### Phase 3: Row Presentation Cutover

- Rewrite row markup to content-first, always-visible controls.
- Remove color swatch, compact exact preview, badges-as-proxy, quote card, and
  expanded-only note/actions.
- Make the note editor inline, compact, and borderless in the row.
- Keep linked conversations visible when present.

### Phase 4: Projection And Navigation Tightening

- Implement the final visible-rect selection order.
- Ensure all highlight id selectors are escaped.
- Recalculate on scroll, resize, image load/error, note local edits, highlight
  mutation, reader profile changes, PDF render, PDF zoom, and EPUB section
  change.
- Replace raw `scrollIntoView({ block: "center" })` row navigation with the
  reader scroll-root and scroll-padding-aware path.

### Phase 5: Tests And Cleanup

- Rewrite `AnchoredHighlightsRail` tests around the final row contract.
- Add picker and action-menu tests.
- Update selection popover tests for shared picker reuse.
- Add browser tests for scroll-driven row visibility/alignment where jsdom is
  insufficient.
- Delete stale overlay/list tests and snapshots.
- Run typecheck, lint, unit tests, and browser tests.

## Key Decisions

- The gutter stays. It is the collapsed highlight overview, not legacy UI.
- The expanded desktop surface is a stable rail, not a modal slide-over.
- `Highlights` is contextual. It shows highlights in view, not all highlights in
  the document.
- `Ask` shares the same rail so reader context remains local.
- Row focus remains useful for visual sync and edit-bounds ownership, but focus
  does not reveal controls.
- Color selection is a shared highlight component, not menu text duplicated in
  each caller.
- Mobile remains drawer/sheet based because a persistent rail is not useful on
  narrow screens.

## Acceptance Criteria

- Desktop readable media opens with a collapsed right highlight gutter by default.
- Expanding the gutter opens a stable right-side rail and reflows the reader.
- No desktop highlights slide-over appears.
- No desktop reader-chat slide-over appears.
- `Highlights` rows render only for viewport-visible source targets.
- Rows stay aligned to visible source targets while scrolling.
- Offscreen highlights do not render as contextual rows.
- Every visible row is left-aligned.
- Every visible row shows full context with the exact selection marked.
- No visible row shows a separate color swatch.
- No visible row shows an exact-only compact preview.
- Ask button is visible immediately on every row where quoting is available.
- Menu button is visible immediately on every row where actions are available.
- Note editor is visible immediately on every row.
- The note editor is compact and borderless in resting state.
- Color changing in the row menu uses the same picker component as the selection
  popover.
- Clicking row content scrolls to the source highlight.
- Clicking source highlighted text does not disclose row controls or switch to
  Ask.
- Selecting text and invoking Ask switches the local rail to `Ask`.
- Asking from a saved highlight row switches the local rail to `Ask`.
- Mobile media Ask still uses a sheet.
- Mobile highlights still use a local drawer.
- Removed overlay/list files and tests are deleted or verified absent.
- `cd apps/web && bun run typecheck` passes.
- `cd apps/web && bun run lint` passes.
- `cd apps/web && bun run test:unit` passes.
- `cd apps/web && bun run test:browser` passes.
