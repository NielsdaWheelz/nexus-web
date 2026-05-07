# Chat Composer Bottom Dock Hard Cutover

## Role

This document is the target-state plan for fixing chat composer placement across
full conversation chat, new chat, and embedded reader chat surfaces.

The problem is layout ownership, not chat runtime behavior. The composer must
stay bottom-docked as a real layout region, and transcript content, inline
message errors, pane feedback, pending assistant rows, branch controls, and
composer feedback must remain visible and reachable.

## Hard-Cutover Policy

This is a hard cutover.

- Replace the current sticky-in-scrollport composer layout in one pass.
- Keep no legacy chat surface layout.
- Add no feature flag, compatibility mode, fallback branch, or parallel code path.
- Do not preserve the old behavior where a sticky composer can paint over
  transcript content.
- Do not add a second composer or a route-specific composer layout.
- Do not keep CSS that exists only to support the old overlay-prone structure.

The final behavior supersedes the literal implementation implied by "sticky at
the bottom of the chat scrollport" in older chat workbench docs. The product
meaning remains bottom-docked and always available. The implementation is a
reserved footer region outside the transcript scrollport, not an overlay inside
it.

## Context

Current chat panes are contained panes. The pane shell hides pane body overflow,
so chat owns its own scroll container.

Current `ChatSurface` renders this shape:

```text
ChatSurface
  scrollport role="region"
    transcript role="log"
      messages
    composerSlot position: sticky; bottom: 0
      ChatComposer
```

The risky combination is:

- `.scrollport` owns `overflow-y: auto` and `display: flex`.
- `.transcript` is `flex: 1`.
- `.composerSlot` is `position: sticky; bottom: 0`.

With long or dynamic transcript content, the sticky composer can cover the last
message or inline feedback instead of reserving usable space for it.

## Goals

- Keep exactly one primary composer per chat surface.
- Keep the composer visually docked to the bottom edge of the chat surface.
- Reserve layout space for the composer so it never covers transcript content.
- Make the transcript the only scrollable chat content region.
- Preserve the existing named chat region and named message log accessibility
  contract.
- Preserve scroll intent semantics from chat streaming:
  - new outgoing messages force scroll to bottom
  - streaming remains pinned only while the user is near the bottom
  - loading older messages preserves scroll position
- Preserve branch mode, attached context chips, model settings, and composer
  draft behavior.
- Preserve the existing behavior that wheel gestures over the composer scroll
  the transcript when the transcript can scroll.
- Add geometry-level test coverage for bottom docking and non-overlap.

## Non-Goals

- Do not redesign `ChatComposer` visual hierarchy.
- Do not change model/provider settings behavior.
- Do not change chat-run creation, streaming, SSE, reconciliation, or backend
  contracts.
- Do not change message rendering, branch graph behavior, citations, or evidence
  disclosure.
- Do not change the feedback layer model.
- Do not migrate composer submission errors from the existing composer-local
  error display unless needed for layout correctness.
- Do not change pane routing or workspace layout semantics.

## Final State

`ChatSurface` owns a two-region column:

```text
ChatSurface
  transcriptScrollport role="region" aria-label="Chat conversation"
    transcript role="log" aria-label="Chat messages"
      scope banner
      load older control
      empty state
      messages
  composerDock
    ChatComposer
```

The scrollport is the only element referenced by `scrollportRef`.

The composer dock is a normal flex child of `ChatSurface`. It is outside the
scrollport, consumes real height, and cannot overlap the transcript. It is not
`position: fixed`, `position: absolute`, or sticky inside the transcript
scrollport.

The transcript can scroll until the final message, inline error notice, or
pending assistant row is fully visible above the composer dock.

## Target Behavior

### Full Conversation Chat

- The pane body remains `data-body-mode="contained"`.
- The pane body does not scroll.
- The chat transcript scrollport owns vertical scroll.
- The composer remains bottom-docked at every scroll position.
- At scroll bottom, the final visible transcript item is not obscured by the
  composer.
- Pane-level load and mutation errors render above `ChatSurface` and reduce
  available chat height without creating a second body scroll.

### New Chat

- Empty state content is vertically placed inside the transcript scrollport.
- The composer is bottom-docked before the first send.
- After first send, local messages stream into the transcript and the composer
  remains in the dock.
- URL replacement from `/conversations/new` to `/conversations/:id` does not
  remount into a different layout mode.

### Embedded Reader Assistant

- `ReaderAssistantPane` uses the same `ChatSurface` layout.
- Pending quote context and resolve/load feedback above `ChatSurface` reduce
  available transcript height without covering the composer or transcript.
- Full chat promotion remains explicit and does not change composer placement.

### Message Errors And Feedback

- Message-level `FeedbackNotice` rows are transcript content and can scroll fully
  above the composer.
- Pending assistant rows remain visible while streaming and reconciling.
- Composer-local submission errors are inside the dock and may increase dock
  height. Increased dock height must reduce transcript height instead of
  covering transcript content.

### Branch Mode

- Branch mode renders in the same composer dock.
- Branch headers, selected quote preview, attached context rail, and textarea
  growth increase dock height and reserve space.
- Jump-to-parent and branch switching continue to target the transcript
  scrollport.

### Mobile

- The composer dock respects `env(safe-area-inset-bottom)`.
- Mobile pane chrome behavior remains owned by `PaneShell`.
- Mobile model settings may still render as a fixed sheet, because that is an
  explicit dialog layer separate from composer docking.
- Mobile viewport changes must not leave the composer floating in the middle of
  the chat surface.

## Architecture

### Ownership

`ChatSurface` owns layout only:

- surface column
- transcript scrollport
- named message log
- composer dock
- load-older placement
- empty-state placement
- wheel forwarding from composer dock to transcript scrollport

Conversation pages and reader assistant panes own runtime state:

- message arrays
- scroll intent refs
- active branch state
- active run tailing
- URL and pane runtime behavior

`ChatComposer` owns composer internals:

- draft text
- model settings
- branch header rendering
- context rail rendering
- send action
- composer-local error display

### Scroll Contract

The scrollport ref passed into `ChatSurface` points to the transcript scrollport.
All existing scroll logic keeps that semantic meaning:

- `scrollTop = scrollHeight` means scroll transcript to bottom.
- near-bottom detection uses transcript `scrollHeight`, `scrollTop`, and
  `clientHeight`.
- load-older restoration compares transcript scroll metrics before and after
  prepending messages.

The composer dock is not part of transcript `scrollHeight`.

Wheel events over the composer dock are forwarded to the transcript scrollport
when all of the following are true:

- the event is not already prevented
- the event has vertical delta
- the transcript can scroll in the requested direction

This forwarding is a deliberate interaction rule, not a compatibility fallback.

### Layout Rules

- Use flex or grid to reserve composer dock height.
- Do not use fixed composer height constants.
- Do not use bottom padding guesses to compensate for overlay.
- Do not measure composer height with JavaScript unless CSS layout cannot
  express the final state.
- Do not put the composer inside the transcript `role="log"`.
- Do not put the composer inside the transcript scrollport.
- Do not create nested scroll containers inside the message log.
- Keep the transcript column constrained to `var(--content-max-width)`.
- Keep composer visual width aligned with the transcript width.

## Files

### Primary Frontend Files

- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/ChatSurface.module.css`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ChatComposer.module.css`

### Chat Surface Callers

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`

### Pane And Workspace Context

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/PaneShell.module.css`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/app/(authenticated)/conversations/page.module.css`

These files should not need routing or shell behavior changes. They are listed
because they define the contained-pane height and scroll ownership boundaries.

### Tests

- `apps/web/src/__tests__/components/ChatSurface.test.tsx`
- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
- `apps/web/src/__tests__/components/ReaderAssistantPane.test.tsx`
- `apps/web/src/components/chat/ChatStreamingHardCutover.test.tsx`
- `e2e/tests/conversations.spec.ts`
- `e2e/tests/real-media/quote-to-chat.spec.ts`

## Implementation Plan

1. Add failing layout assertions.
   - Assert the composer is outside the named transcript scrollport.
   - Assert the transcript log remains inside the named scrollport.
   - Assert `scrollportRef.current` is the transcript scrollport.

2. Refactor `ChatSurface` structure.
   - Move `composerSlot` outside the scrollport.
   - Keep the transcript and all messages inside the scrollport.
   - Keep the same public props.
   - Preserve role names and labels.

3. Replace overlay-prone CSS.
   - Remove sticky positioning from composer slot.
   - Make `.surface` a full-height column.
   - Make `.scrollport` the flexible scroll owner.
   - Make `.composerSlot` a non-scrolling footer dock.
   - Preserve safe-area padding on mobile.

4. Preserve wheel-over-composer transcript scrolling.
   - Add a small event handler in `ChatSurface`.
   - Forward vertical wheel delta to the transcript scrollport only when it can
     scroll.
   - Keep the behavior independent of chat runtime state.

5. Verify caller scroll logic.
   - Confirm conversation detail, new conversation, and reader assistant still
     set and read transcript scroll metrics through `scrollportRef`.
   - Confirm branch switching and jump-to-parent still use transcript offsets.
   - Confirm loading older messages still restores transcript position.

6. Add end-to-end regression coverage.
   - Seed a long conversation.
   - Scroll to bottom.
   - Assert the composer bottom aligns with the chat surface bottom.
   - Assert the final message or final message error is fully above the
     composer top.
   - Assert pane body scroll remains zero.
   - Assert wheel over composer scrolls the transcript.

7. Delete old layout assumptions.
   - Remove sticky-in-scrollport CSS.
   - Remove any test wording that says the composer is inside the scrollport.
   - Keep tests that assert one named region and one named message log.

## Acceptance Criteria

### Product Acceptance

- The chat input is always bottom-docked in full conversation chat.
- The chat input is always bottom-docked in new chat.
- The chat input is always bottom-docked in embedded reader assistant chat.
- No message content is hidden behind the composer.
- No message-level error or feedback notice is hidden behind the composer.
- Composer-local errors expand the dock without hiding transcript content.
- Long attached context rails and branch headers expand the dock without hiding
  transcript content.
- The final message can be fully read at scroll bottom.
- Wheel gestures over the composer can scroll the transcript.

### Architecture Acceptance

- `ChatSurface` has one transcript scrollport.
- `ChatSurface` has one message log.
- The composer dock is outside the transcript scrollport.
- The composer is not inside `role="log"`.
- The composer dock uses normal layout flow, not overlay positioning.
- Conversation and reader assistant callers keep using `scrollportRef` for
  transcript scroll state.
- Chat streaming runtime files are not changed for layout concerns.
- Backend files are not changed.

### Accessibility Acceptance

- The transcript scrollport remains `role="region"` with
  `aria-label="Chat conversation"`.
- The transcript remains `role="log"` with `aria-label="Chat messages"`.
- The composer textarea remains reachable by keyboard after transcript content.
- Message errors retain alert semantics from `FeedbackNotice`.
- The layout does not require duplicate hidden regions or duplicate composers.

### Test Acceptance

- Component tests cover DOM ownership and ref ownership.
- Browser or Playwright coverage checks geometry:
  - composer bottom equals chat surface bottom within a small pixel tolerance
  - final transcript item bottom is less than or equal to composer top at scroll
    bottom
- Existing scroll ownership e2e coverage still passes:
  - chat scrollport scrolls
  - pane body does not scroll
  - wheel over composer scrolls chat
- Existing streaming tests still pass without runtime changes.

## Key Details

- The existing `scrollTop = scrollHeight` pattern remains valid because it now
  targets only transcript content.
- The composer dock height is naturally excluded from transcript `clientHeight`.
  This is the desired behavior.
- If an error is rendered above `ChatSurface`, the containing flex layout reduces
  the available height for `ChatSurface`.
- If an error is rendered inside a message row, it is transcript content and
  scrolls with the message.
- If an error is rendered inside `ChatComposer`, it is dock content and increases
  the reserved dock height.
- `scrollbar-gutter: stable` should remain on the transcript scrollport to avoid
  lateral shifts.

## Key Decisions

- Use a reserved footer dock instead of sticky positioning inside the scrollport.
- Keep the `ChatSurface` prop API stable.
- Keep scroll ownership with the transcript scrollport.
- Preserve wheel-over-composer scrolling through explicit event forwarding.
- Prefer CSS layout over JavaScript height measurement.
- Test visual geometry, not only DOM order.
- Treat this as a single cutover with no legacy layout branch.

## Deletion Checklist

- Delete `position: sticky` from the chat composer slot.
- Delete old assumptions that the composer is a child of the scrollport.
- Delete any padding shim that exists only to offset a sticky overlay.
- Delete any duplicated mobile-specific composer positioning that conflicts with
  the dock.

## Risks

- Browser wheel forwarding can accidentally block native textarea scrolling if it
  is too broad. The handler must only forward when the wheel target is not
  consuming its own vertical scroll.
- Mobile dynamic viewport changes can expose assumptions about `100vh`; the app
  already uses `100dvh`, and this cutover should preserve that.
- Very tall composer states can leave little transcript space. That is preferable
  to overlap, but tests should include branch/context/error growth.

## Definition Of Done

- The old sticky-in-scrollport composer layout cannot be reached.
- All chat surfaces use the same bottom-docked composer architecture.
- The final transcript item is readable above the composer in long chats.
- Inline message errors and composer errors are both visible in their owning
  regions.
- Unit and e2e tests cover the new layout contract.
- No backend, streaming, or route compatibility code was added for this fix.
