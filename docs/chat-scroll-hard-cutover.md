# Chat Scroll Hard Cutover

## Purpose

Fix chat scrolling by making scroll ownership explicit.

The current chat view mixes a standard pane body scroll model with an inner
transcript scroll model. The final state has one primary chat scrollport, no
legacy overflow overrides, no feature flag, no fallback path, and no duplicate
layout path.

## Goals

- Wheel and trackpad scrolling work over the main chat pane.
- The message list and composer stay in one predictable vertical layout.
- The linked-context side pane keeps its own independent scroll.
- Chat does not rely on `overflow: hidden` to mask an unconstrained layout.
- Horizontal overflow is removed, not hidden.
- Scroll behavior is accessible from keyboard and assistive technology.
- The implementation stays local, direct, and easy to read.
- The change follows `docs/rules/simplicity.md`, `docs/rules/module-apis.md`,
  `docs/rules/control-flow.md`, `docs/rules/conventions.md`, and
  `docs/rules/testing_standards.md`.

## Target Behavior

- Full chat and quote chat use the same `ChatSurface`.
- The chat primary column has exactly one vertical scroll owner.
- Scrolling over messages, empty transcript space, or the composer surface moves
  that same chat scroll owner.
- If the textarea has grown tall enough to scroll, wheel input inside the
  textarea first scrolls the textarea; at its boundary, normal browser scroll
  chaining can reach the chat scroll owner.
- The composer remains visible at the bottom of the chat surface.
- Short conversations keep the composer bottom-pinned.
- Long conversations scroll messages behind the bottom composer without hiding
  the last message.
- Loading older messages preserves the visible message position.
- New messages and streaming deltas auto-scroll only when the user is already
  near the bottom or when the local user just sent a message.
- If the user has scrolled up, incoming assistant updates do not yank the view
  to the bottom.
- Mobile chat content does not render under pane chrome or the safe area.
- The linked-context side pane scrolls independently from the main chat pane.
- Body, authenticated layout, workspace host, and pane shell remain viewport
  containers; they do not become document scroll fallbacks.

## Final State

### Removed

- Chat-specific reliance on standard pane body scrolling.
- `min-height: 100%` in the chat split layout chain.
- The `.paneContentChat` overflow override as a scroll fix.
- Any optional test-only `ChatSurface` prop that exists only to name a test id.
- Any CSS that hides horizontal overflow in the composer instead of making
  controls fit.
- Any legacy class or branch kept only to preserve the old nested-scroll layout.

### Kept

- `ChatSurface` owns the chat transcript/composer layout.
- `ChatComposer` owns message entry, model settings, context chips, and send
  behavior.
- `ConversationPaneBody` owns conversation data, streaming, pagination, and
  scroll intent.
- `ConversationContextPane` owns linked-context side pane content.
- `QuoteChatSheet` keeps using `ChatSurface` and `ChatComposer`.
- Chat-run request and response shapes stay unchanged.
- SSE event handling stays unchanged except for scroll intent wiring.

## Architecture

Use three pane body modes:

```text
standard
  pane shell body scrolls

document
  route owns document scrolling and may drive mobile document chrome

contained
  route owns one internal app-surface scrollport
  pane shell body clips and stays height-constrained
  mobile pane chrome stays visible like a standard pane
```

`contained` is a narrow shell contract, not a reusable layout framework. It is
justified because chat is neither a normal scrolling standard pane nor a
document reader pane. It removes the current ambiguous ownership instead of
adding another local overflow workaround.

Chat routes use `contained`:

```text
PaneShell body
  routeShell
    paneRouteBoundaryShell
      chatSplitLayout
        chatPrimaryColumn
          ChatSurface
            chat scrollport
              message log
              sticky composer slot
        chatContextColumn
          ConversationContextPane scrollport
```

`ChatSurface` provides the primary chat scrollport. The message list is a child
inside that scrollport and has chat log semantics. The composer is also inside
the scrollport, but outside the message log.

## Structure

### Pane Shell

- Add `contained` to the existing `PaneBodyMode` union.
- For `contained`, `PaneShell` body uses:
  - `display: flex`,
  - `flex-direction: column`,
  - `min-height: 0`,
  - `overflow: hidden`.
- Mobile `contained` panes reserve the same pane chrome space as standard panes.
- `contained` panes do not call or require `usePaneChromeScrollHandler`.
- Do not add a generic route body wrapper.
- Do not add per-route scroll options.

### Chat Route Layout

- `.chatSplitLayout` is height-constrained.
- `.chatPrimaryColumn` is height-constrained.
- `.chatContextColumn` is height-constrained.
- Use `height: 100%`, `min-height: 0`, and `min-width: 0` through the chat
  layout chain.
- Avoid `min-height: 100%` in this chain.
- The side pane stays `flex: 0 0 320px` on desktop and absent on mobile.

### ChatSurface

- Rename the forwarded scroll ref to match what it points at.
- Put the ref on the chat scrollport, not on the message-list child.
- The scrollport is focusable and named.
- The message-list child uses `role="log"` and a clear accessible name.
- The composer slot is sticky to the bottom of the scrollport.
- Use CSS layout to keep the final message visible above the composer.
- Prefer `scrollbar-gutter: stable` on the scrollport if it does not create
  visual regressions.
- Do not add a `ScrollArea` component.
- Do not add a custom wheel event forwarder.
- Do not add a virtualization library in this cutover.

### Scroll Intent

- Keep scroll intent local to `ConversationPaneBody` and `QuoteChatSheet`.
- On user scroll, set auto-scroll intent from whether the scrollport is near the
  bottom.
- On local send, force auto-scroll intent to true.
- On stream resume or merge, do not force auto-scroll if the user has moved away
  from the bottom.
- On older-message load, measure before prepend and restore after render.
- Keep the threshold inline unless it is reused or the name carries real meaning.

### Accessibility

- The primary chat scrollport is keyboard focusable.
- The primary chat scrollport has an accessible name.
- The message list has log semantics for ordered message updates.
- The composer remains after the message log in DOM order.
- Focus order stays linear: scrollport, message actions/links if present,
  composer controls.
- Do not add positive `tabindex`.
- Do not remove visible focus styling.

## Rules

- Hard cutover only.
- No feature flag.
- No legacy class kept for compatibility.
- No fallback layout.
- No duplicate scroll model.
- No generic scroll utility.
- No generic pane layout wrapper.
- No manifest, registry, builder, adapter, or DSL.
- No one-use exported type.
- No one-use helper unless it hides substantial incidental complexity.
- No one-use constant unless the name improves the usage site.
- No intermediate view model or route model.
- No staging variables that only rename an expression.
- Branch explicitly on finite sets.
- Preserve existing module boundaries.
- Keep frontend changes in `apps/web/`.
- Keep tests behavior-focused and browser-backed where layout matters.

## Key Decisions

1. Add `contained` pane body mode.

   Chat needs shell clipping and internal scroll ownership without document-reader
   mobile chrome behavior. A single explicit mode is clearer than keeping local
   chat CSS that fights `standard`.

2. Make `ChatSurface` the chat scroll owner.

   The broken behavior is caused by unclear ownership between shell, transcript,
   and composer. The surface already owns transcript/composer layout, so it is
   the narrowest owner for the scrollport.

3. Keep the composer inside the scrollport.

   This lets wheel and trackpad input over the composer surface reach the same
   vertical scroll owner without custom event forwarding.

4. Keep the message log separate from the scrollport semantics.

   The scrollport can contain the sticky composer. The message-list child owns
   `role="log"` so interactive composer controls are not part of the log.

5. Do not introduce `ScrollArea`.

   There is not enough real reuse to justify a shared component. Local markup and
   CSS are faster to audit.

6. Do not introduce virtualization.

   Virtualization is the right future answer for very large histories, but this
   bug is scroll ownership and sizing. Adding virtualization now would expand the
   blast radius.

7. Test scroll behavior in Chromium.

   Layout and scroll ownership are browser behavior. Unit tests that only assert
   DOM order are insufficient.

## Files

### Update

- `apps/web/src/components/workspace/PaneShell.tsx`
  - Add `contained` body mode handling.
  - Keep the body-style branch explicit.

- `apps/web/src/components/workspace/PaneShell.module.css`
  - Apply mobile chrome top reservation to `contained`.

- `apps/web/src/components/workspace/WorkspaceHost.module.css`
  - Ensure contained route shells are height-constrained.

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  - Move `/conversations/new` and `/conversations/:id` to `contained`.

- `apps/web/src/app/(authenticated)/conversations/page.module.css`
  - Replace `min-height: 100%` chat sizing with bounded height and `min-height: 0`.
  - Remove chat overflow rules that only paper over unconstrained sizing.

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - Point the scroll ref at the chat scrollport.
  - Track near-bottom scroll intent.
  - Preserve position when older messages prepend.

- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
  - Use the same bounded chat layout without special cases.

- `apps/web/src/components/chat/ChatSurface.tsx`
  - Move scroll ownership to the surface scrollport.
  - Add accessible scrollport and log semantics.
  - Remove test-id-oriented prop surface.

- `apps/web/src/components/chat/ChatSurface.module.css`
  - Make the surface the scrollport.
  - Make the composer slot sticky.
  - Keep the message log bounded and readable.

- `apps/web/src/components/chat/QuoteChatSheet.tsx`
  - Use the renamed scroll ref.
  - Track the same scroll intent and older-message preservation as full chat.

- `apps/web/src/components/chat/QuoteChatSheet.module.css`
  - Adjust only if the shared `ChatSurface` needs sheet-specific containment.

- `apps/web/src/__tests__/components/PaneShell.test.tsx`
  - Cover contained pane body overflow and mobile chrome reservation.

- `apps/web/src/__tests__/components/ChatSurface.test.tsx`
  - Cover scrollport semantics, composer order, and bottom-pinned empty state.

- `apps/web/src/__tests__/components/QuoteChatSheet.test.tsx`
  - Query by role/name instead of old test ids.

- `e2e/tests/conversations.spec.ts`
  - Add a real-stack scroll ownership assertion for chat.

### Avoid Unless Proven Necessary

- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ChatComposer.module.css`
- backend files
- migrations
- API routes
- SSE client code
- generic UI components

## Acceptance Criteria

- Chat primary pane has one vertical scroll owner.
- `PaneShell` body for chat does not become the effective vertical scroll area.
- Full chat scrolls by wheel or trackpad over messages.
- Full chat scrolls by wheel or trackpad over the composer surface when the
  textarea is not consuming the gesture.
- Quote chat scrolls through the same shared surface behavior.
- Linked-context side pane scroll still works independently.
- The final message remains visible above the composer at the bottom.
- New chat keeps the composer bottom-pinned.
- Loading older messages preserves the current visible position.
- Streaming deltas keep the view pinned only when the user is near the bottom or
  just sent a message.
- Streaming deltas do not yank the viewport when the user is reading older
  messages.
- Mobile chat content is not covered by pane chrome.
- Mobile chat content respects bottom safe area.
- No horizontal composer scroll exists at `320px`, `390px`, `640px`, or desktop
  pane widths.
- The chat scrollport is keyboard focusable.
- The chat scrollport has an accessible name.
- The message list exposes log semantics.
- Browser component tests cover the scrollport contract.
- E2E covers the real chat scroll path.
- `bunx tsc --noEmit` passes in `apps/web`.
- `bun run lint` passes in `apps/web`.
- Targeted browser component tests pass.
- Targeted conversations E2E passes when local services are available.

## Non-Goals

- Do not redesign message rows.
- Do not redesign composer controls.
- Do not add a jump-to-latest button.
- Do not add virtualized messages.
- Do not add a generic scroll component.
- Do not change linked-context pane behavior beyond preserving its scroll.
- Do not change chat-run persistence.
- Do not change backend schemas.
- Do not change SSE event shapes.
- Do not change model selection behavior.
- Do not change quote-to-chat routing rules.
- Do not change mobile command palette behavior.

## Implementation Order

1. Add failing browser/E2E coverage for chat scroll ownership.
2. Add `contained` pane body mode and move chat routes to it.
3. Replace chat layout sizing with bounded height and `min-height: 0`.
4. Move `ChatSurface` scroll ownership to the surface scrollport.
5. Wire scroll intent and older-message position preservation.
6. Update quote chat to the shared scroll contract.
7. Remove old test-id and nested-scroll assumptions.
8. Run targeted typecheck, lint, browser tests, and conversations E2E.
