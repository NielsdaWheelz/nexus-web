# Reader Secondary Rail Hard Cutover

## Status

Implemented target.

## Role

This document owns the target state for desktop reader-adjacent secondary rails:
media highlights, media Ask, and chat context. It supersedes the Visual Refactor
1B slide-over target for desktop reader chat and expanded highlights. Mobile
continues to use local drawers and sheets.

The cutover is hard. The final state keeps no desktop highlights slide-over, no
desktop reader-chat slide-over, no compatibility branch for the Visual Refactor
1B overlay shape, no duplicate rail layout primitives, and no fallback path that
opens reader-adjacent work as an unrelated workspace pane.

## Goals

- Keep the media reader's highlight surface collapsed by default.
- Expand the collapsed highlight gutter into a stable desktop right-side
  secondary rail, not a temporary overlay.
- Make `Highlights` and `Ask` sibling modes in the same media secondary rail.
- Render media highlight rows from viewport-visible reader projections, not from
  an all-highlights list.
- Share the desktop secondary rail layout primitive between media and chat.
- Keep mobile behavior drawer- or sheet-based.
- Preserve the workspace pane runtime for independent resources, while making
  reader-adjacent work local to the owning pane.
- Remove the desktop overlay implementation paths in the same cutover.

## Non-Goals

- Do not redesign the global workspace pane runtime.
- Do not remove full conversation panes or normal workspace pane opening.
- Do not build an all-highlights notebook surface.
- Do not make mobile use a persistent secondary rail.
- Do not change durable saved-highlight storage.
- Do not change chat context, memory, or fork domain semantics.
- Do not persist viewport projection, rail expansion, row position, or DOM rects.
- Do not introduce feature flags, query toggles, or environment gates.

## Hard-Cutover Policy

- No feature flags.
- No legacy desktop reader overlay path.
- No fallback from media Ask or media Highlights to `requestOpenInAppPane`.
- No backward-compatible wrapper components around removed overlay APIs.
- No duplicated old/new test paths.
- Delete or rewrite tests that assert removed overlay behavior.
- Update docs that describe superseded desktop overlay behavior.

## Final State

Desktop media panes have one right-side reader secondary rail.

- Collapsed state: a narrow gutter remains visible at the reader's right edge.
- Expanded state: the gutter becomes a stable rail that occupies layout space and
  reflows the reader column.
- The rail has `Highlights` and `Ask` modes.
- `Highlights` renders viewport-visible highlight rows aligned to rendered
  source targets.
- `Ask` renders the reader assistant in the same rail.
- Invoking Ask from a selection or saved highlight switches the rail to `Ask`
  and leaves the document in place.
- Returning to `Highlights` preserves highlight focus and projection behavior.
- Closing or minimizing the rail returns to the collapsed gutter.

Desktop conversation panes use the same secondary rail primitive.

- The chat primary column remains the conversation transcript and composer.
- The right rail hosts chat `Context` and `Forks` domain content.
- The chat rail may be expanded by default on desktop.
- Mobile chat context continues to use `ChatContextDrawer`.

Mobile media panes keep the existing local sheet/drawer pattern.

- Media Ask uses the mobile reader assistant sheet.
- Expanded highlights use a mobile drawer or sheet.
- No mobile viewport attempts to preserve a persistent side rail.

## Target Behavior

### Desktop Media Collapsed

1. Opening readable media shows the reader plus a narrow right gutter.
2. The gutter contains highlight ticks and an expand affordance.
3. Clicking a tick scrolls and pulses the source highlight.
4. Clicking the expand affordance opens the secondary rail in `Highlights` mode.
5. The reader column reflows to make room for the rail.

### Desktop Media Highlights

1. The expanded rail shows `Highlights` as the active mode.
2. Rows render only for highlights with at least one rendered target rect
   intersecting the reader viewport.
3. Rows align vertically to their visible source target.
4. Scrolling the reader updates visible rows and row alignment.
5. Clicking a row focuses the highlight and scrolls the source target into view.
6. Clicking a source highlight focuses the row when that row is visible.
7. Offscreen highlights remain durable data but do not render in the contextual
   rail.

### Desktop Media Ask

1. Selecting text and invoking Ask expands the rail if needed.
2. The rail switches to `Ask`.
3. The selected quote appears as pending context.
4. The composer is focused without changing the active workspace pane.
5. Asking from a saved highlight row attaches that highlight as context and
   switches the same rail to `Ask`.
6. Full chat opens only through explicit promotion after a conversation exists.

### Desktop Chat

1. Conversation panes render their right-side context/forks UI inside the shared
   secondary rail primitive.
2. The rail uses the same width, border, surface, collapsed gutter contract, and
   expansion API as media.
3. Chat domain content remains owned by `ConversationContextPane`.
4. Chat context actions and fork switching keep their existing behavior.

### Mobile

1. Media highlights and Ask do not render as persistent side rails.
2. Chat context does not render as a persistent side rail.
3. Existing mobile sheet/drawer behavior remains the only mobile path.

## Architecture

### Shared Rail Primitive

Create a small layout primitive for desktop secondary rails. It owns layout
behavior only:

- expanded and collapsed widths
- gutter rendering slot
- panel rendering slot
- mode/tab rendering slot
- border, surface, overflow, and sizing
- expand, collapse, and mode callbacks
- desktop-only layout contract

It does not know about highlights, chat context, forks, memory, reader
assistant state, or workspace routes.

### Media Rail

`MediaPaneBody` owns media rail state and composes the shared rail directly:

- rail expanded/collapsed
- current mode: `highlights` or `ask`
- reader assistant session
- pending reader-selection and saved-highlight contexts
- promotion to full conversation pane
- `ReaderGutter` in collapsed mode
- contextual projected highlight rows in `Highlights` mode
- `ReaderAssistantPane` in `Ask` mode

### Highlight Projection

The contextual highlight pane is projection-driven.

- Text readers measure rendered highlight spans selected by
  `data-active-highlight-ids`.
- PDF readers use page geometry and viewport transforms.
- Transcript readers use rendered transcript highlight targets or time-derived
  positions only where rendered text geometry is unavailable.
- Projection state is frontend-only and recalculated on scroll, resize, reader
  reflow, PDF render, PDF zoom, section change, and highlight refresh.
- Durable anchors and viewport projections remain distinct types.

### Chat Rail

Conversation panes use the same rail primitive but keep domain content unchanged.

- `ConversationPaneBody` renders `ConversationContextPane` inside the rail.
- `ConversationNewPaneBody` renders pending context inside the rail.
- `ChatContextDrawer` remains mobile-only.

## Rules

- Desktop expanded reader-adjacent work is a stable rail, not an overlay.
- Mobile reader-adjacent work is a drawer or sheet, not a persistent rail.
- A collapsed media rail still exposes the highlight gutter.
- A contextual media highlight row exists only when its source target is visible.
- Do not render offscreen highlights by clamping rows into the rail.
- Do not persist projection rects, row positions, scroll offsets, or rail pixel
  state.
- Do not use active page, active fragment, or active EPUB section as a proxy for
  viewport visibility.
- Do not open a workspace pane as the default path for media Ask or media
  Highlights.
- Keep rail layout behavior in the shared primitive.
- Keep domain behavior in media/chat-specific components.

## Files

### Add

- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/components/secondaryRail/SecondaryRail.module.css`
- `apps/web/src/components/reader/AnchoredHighlightsRail.tsx`
- `apps/web/src/components/reader/AnchoredHighlightsRail.module.css`

### Change

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - replace desktop `HighlightsInspectorOverlay` and `ReaderChatOverlay` with
    direct `SecondaryRail` composition
  - keep mobile `QuoteChatSheet`
  - route selection Ask and saved-highlight Ask into the rail
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
  - replace overlay host assumptions with split reader + rail layout
  - keep narrow gutter sizing in the collapsed state
- `apps/web/src/components/reader/ReaderGutter.tsx`
  - keep as collapsed media gutter
  - keep tick jump and pulse behavior
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - render `ConversationContextPane` through the shared rail primitive
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
  - render pending context through the shared rail primitive
- `apps/web/src/app/(authenticated)/conversations/page.module.css`
  - remove bespoke desktop context-column rail layout after migration
- `docs/visual-refactor-1b-hard-cutover.md`
  - mark desktop reader overlay requirements as superseded by this document

### Delete

- `apps/web/src/components/reader/HighlightsInspectorOverlay.tsx`
- `apps/web/src/components/reader/HighlightsInspectorOverlay.module.css`
- `apps/web/src/components/chat/ReaderChatOverlay.tsx`
- `apps/web/src/components/chat/ReaderChatOverlay.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlightOrdering.ts`

## Key Decisions

- The shared primitive is a layout shell, not a domain component.
- Media and chat use the same rail shell but keep separate content ownership.
- Media `Highlights` is contextual and viewport-visible, not an all-highlights
  list.
- The collapsed media gutter remains first-class because it is useful while
  reading.
- Mobile remains modal because narrow screens cannot preserve a useful side rail.
- Ask and Highlights share one media rail so source context, highlight focus, and
  assistant state stay local to the reader.

## Acceptance Criteria

- Desktop media opens with a collapsed right highlight gutter by default.
- Expanding highlights opens a stable right-side rail and reflows the reader.
- No desktop highlights slide-over appears.
- No desktop reader-chat slide-over appears.
- Selecting text and invoking Ask switches the media rail to `Ask`.
- Asking from a saved highlight row switches the same rail to `Ask`.
- `Highlights` rows are driven by viewport-visible source targets.
- Offscreen highlights do not render as contextual rows.
- Desktop chat context/forks render through the shared rail primitive.
- Mobile media Ask still uses a sheet.
- Mobile chat context still uses a drawer.
- Removed overlay tests are deleted or rewritten against the rail behavior.
- Docs no longer describe desktop reader overlays as the active target.

## Test Strategy

- Component tests cover shared rail expanded/collapsed behavior.
- Component tests cover media rail mode switching from gutter, highlight row Ask,
  and selection Ask.
- Browser/component tests cover highlight projection visibility and scroll
  updates where practical.
- Existing chat context tests continue to assert context/fork behavior after the
  layout wrapper changes.
- E2E reader tests assert that desktop rail expansion changes layout width rather
  than overlaying the reader.
- Mobile E2E or component coverage asserts drawer/sheet behavior remains mobile
  only.
