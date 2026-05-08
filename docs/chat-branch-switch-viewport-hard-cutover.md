# Chat Branch Switch Viewport Hard Cutover

## Purpose

Replace branch-switch scroll-to-top behavior with stable viewport anchoring for
full conversation chat.

Branch switching changes the selected transcript path. It must not yank the chat
scrollport to the top. The visible reading context is part of the interaction
state and must survive branch switches whenever the new selected path can
represent that context.

This is a hard cutover. There is no feature flag, no compatibility mode, no
legacy scroll-to-top path, and no parallel branch-switch implementation.

## Supersession

This document owns frontend viewport behavior during branch switches. It
complements:

- `docs/chat-workbench-hard-cutover.md` for branch-aware workbench UX
- `docs/chat-unified-components-hard-cutover.md`

This ownership is limited to frontend viewport behavior during branch switches.

## Problem

The current implementation treats branch switching as navigation to a fresh
transcript and sets the chat scrollport to `0`. That behavior is technically
simple, but it is jarring during normal fork comparison:

1. The user is reading a specific area of the transcript.
2. The user activates a fork control near that area.
3. The transcript changes.
4. The viewport jumps to the beginning of the conversation.

The jump destroys local context, forces extra scrolling, and makes fork
comparison feel heavier than it is. The better product model is that branch
switching changes the selected path while preserving the user's reading
position in the transcript when the new path contains an equivalent anchor.

## Goals

1. Preserve visible transcript context across branch switches.
2. Make inline fork comparison feel stable and immediate.
3. Use one branch-switch scroll algorithm for inline fork strips, desktop fork
   tree, branch graph, and mobile drawer switches.
4. Preserve optimistic branch switching before `/active-path` persistence
   resolves.
5. Preserve rollback semantics when active-path persistence fails.
6. Preserve existing chat scroll semantics for outgoing sends, streaming, load
   older, composer wheel forwarding, and jump-to-parent.
7. Keep the implementation frontend-local. No backend API or schema change is
   required.
8. Replace tests and docs that pin scroll-to-top behavior.

## Non-Goals

- Do not redesign conversation branching, branch graph data, fork metadata, or
  active-path persistence.
- Do not add branch diff, compare, merge, preview, or side-by-side views.
- Do not add a user setting for branch-switch scroll behavior.
- Do not keep the old scroll-to-top behavior behind a flag, option, prop, or
  environment variable.
- Do not create separate scroll logic for inline, panel, graph, and mobile
  switches.
- Do not move scroll ownership out of the chat transcript scrollport.
- Do not use browser history, route changes, or pane remounts to model branch
  switches.

## Final State

Full conversation chat has one selected transcript path and one transcript
scrollport.

Activating any enabled branch target immediately swaps the selected path from
the cached path data. During that swap, the branch controller captures the
current viewport anchor, applies the new path, and restores the most precise
equivalent anchor available in the new path. The implementation never
intentionally sets the scrollport to top as part of a successful branch switch.

If the selected path cannot represent the captured semantic anchor, the
scrollport keeps its current scroll offset subject to normal browser clamping.
This is the terminal null-anchor rule, not an old-behavior compatibility path.

When backend persistence returns a reconciled path, the same transition anchor is
applied to the backend path. When persistence fails, the previous path and
previous viewport are restored.

## Target Behavior

### Inline Fork Switching

When the user activates a fork under a visible assistant message:

1. The selected path changes in the same event turn.
2. The active fork state changes in the same event turn.
3. The visible transcript position remains stable.
4. If the top visible message exists in the next path, it remains at the same
   viewport offset.
5. If the top visible message is not in the next path, the fork parent assistant
   message becomes the semantic anchor.
6. The scrollport must not jump to `0` unless the conversation is already at the
   top or browser clamping requires it.

### Desktop Fork Tree Switching

When the user activates a fork from the desktop `Forks` tree:

1. The same branch-switch controller handles the transition.
2. The fork node supplies its `parent_message_id` as the activation anchor.
3. If the current viewport anchor exists in the next path, it wins.
4. If the current viewport anchor does not exist in the next path, the
   activation anchor wins.
5. If neither semantic anchor exists in the next path, the null-anchor rule
   preserves the current scroll offset subject to browser clamping.

### Branch Graph Switching

When the user activates a graph leaf:

1. The graph switch uses the same branch-switch controller.
2. The graph node supplies the best available activation anchor from graph data:
   `parent_message_id` first, then `message_id`.
3. The transition follows the same anchor resolution rules as the desktop fork
   tree.

### Mobile Drawer Switching

When the user activates a fork from the mobile drawer:

1. The drawer closes.
2. The selected path changes.
3. The chat viewport is restored with the same anchor algorithm used on desktop.
4. Closing animation must not race the scroll restoration into a top jump.

### Backend Reconciliation

When `/api/conversations/:id/active-path` returns:

1. The backend path replaces optimistic state when it differs.
2. The current optimistic viewport is captured before applying the backend path.
3. The scrollport does not jump to top during reconciliation.
4. Active run tailing starts for the reconciled visible path.

### Persistence Failure

When `/active-path` persistence fails:

1. The previous selected path is restored.
2. The previous active leaf is restored.
3. The previous fork and graph active state is restored.
4. The previous branch draft state is restored.
5. The previous viewport is restored.
6. Typed feedback remains visible.

### Streaming And Sending

This cutover does not change send or stream scroll semantics:

- New outgoing messages still force the transcript to bottom.
- Streaming deltas keep the transcript pinned only while the user remains near
  the bottom.
- Loading older messages still preserves scroll position by height delta.
- Composer wheel forwarding still scrolls the transcript when the transcript can
  scroll.
- Jump-to-parent still scrolls directly to the parent message.

## Product Rules

- Branch switching changes the selected path; it does not reset reading
  position.
- The product promise is stable visible context, not raw `scrollTop`.
- `scrollTop = 0` is not a branch-switch command.
- A successful branch switch must not use the old scroll-to-top behavior.
- There is one branch-switch path transition engine.
- Every branch switch target must be backed by cached path data before it is
  enabled.
- Scroll anchoring is frontend interaction state. It is not persisted to the
  backend.
- Backend selected-path truth still wins over optimistic frontend state.
- A branch switch must not leave the composer pointing at a hidden branch parent.
- A branch switch must not break active-run visibility filtering.

## Architecture

### Ownership

`ConversationPaneBody` owns branch-switch transition state because it already
owns:

- selected path messages
- active leaf id
- fork options
- branch graph
- branch draft state
- optimistic `/active-path` persistence
- rollback
- chat scroll intent refs

`ChatSurface` remains the scroll owner and renderer. It exposes the transcript
scrollport through `scrollportRef`, renders the named chat region, forwards
composer wheel gestures, and does not know about branch switching.

`ForkStrip`, `ConversationForksPanel`, `ForkGraphOverview`, and
`ChatContextDrawer` remain controls. They pass branch targets and activation
anchor identities to the controller. They do not directly mutate scroll state.

### Viewport Anchor Model

Add a frontend-only anchor type near the branch controller or in a small
chat-local helper module:

```ts
interface BranchScroll {
  anchorMessageId: string | null;
  anchorOffsetTop: number;
  activationAnchorMessageId: string | null;
  activationAnchorOffsetTop: number | null;
  scrollTop: number;
}
```

`anchorMessageId` and `activationAnchorMessageId` are stable
`ConversationMessage.id` values rendered as `data-message-id`.

Offset fields store the message element's top edge minus the scrollport's top
edge at capture time. Restoring the anchor sets scroll so that the same message
appears at the same visual offset.

### Transition Intent

Replace `pendingScrollTopRef` with a transition intent ref:

```ts
const pendingBranchScrollRef = useRef<BranchScroll | null>(null);
```

The transition is created before messages are replaced and consumed in the next
layout pass after messages render.

### Anchor Capture

Capture the current viewport before switching paths:

1. Read the current transcript scrollport.
2. Find visible `[data-message-id]` elements inside the scrollport.
3. Choose the first message whose bottom is below the scrollport top.
4. Prefer a message with a non-negative top offset when available.
5. Store its `messageId` and top offset.
6. Also store the current `scrollTop` for the null-anchor rule and rollback.

This uses existing message DOM identity and does not add new persisted data.

### Anchor Restoration

After the selected path renders, restore in this order:

1. `anchorMessageId` at `anchorOffsetTop` if it exists in the new DOM.
2. `activationAnchorMessageId` at `activationAnchorOffsetTop` if both were
   captured and the message exists in the new DOM.
3. `scrollTop`, clamped by the browser.

The implementation must not append a fourth branch that sets top to `0`.

### Branch-Specific Memory

The controller may cache the latest captured viewport anchor by active leaf id
for the current component lifetime:

This cache is interaction state, not persistence. It is useful when returning to
recently viewed branches, but it must not override the current visible-context
anchor during an explicit branch switch.

### Path Transition Lifecycle

The branch-switch lifecycle is:

1. Validate that `pathCacheByLeafId[nextLeafId]` exists.
2. Create `BranchScroll`.
3. Snapshot previous UI state, including previous viewport transition data.
4. Replace `messages` with the cached selected path.
5. Update selected path ids, active leaf, active fork options, and branch graph.
6. Suspend any branch draft whose parent is not visible in the new path.
7. Consume the transition in `useLayoutEffect`.
8. Start tailing visible active runs.
9. POST `/active-path`.
10. On backend success, apply the backend tree and reuse the same transition
    intent for the reconciled render.
11. On backend failure, restore the previous path and viewport.

## Files

### Must Change

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - Replace `pendingScrollTopRef`.
  - Add viewport anchor capture and restore.
  - Extend `switchToLeaf` to accept activation anchor identity.
  - Keep optimistic switch and rollback behavior.

- `apps/web/src/components/chat/ForkGraphOverview.tsx`
  - Pass enough node context for graph switches to provide an activation anchor.

- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
  - Replace the `scrollTop === 0` assertion.
  - Add viewport-stability assertions for successful switch, reconciliation, and
    rollback.

### May Change

- `apps/web/src/components/chat/ConversationForksPanel.tsx`
  - Only if the current `ForkOption` payload is insufficient for activation
    anchor handoff.

- `apps/web/src/components/chat/ChatContextDrawer.tsx`
  - Only if mobile drawer close timing needs explicit sequencing around the
    shared transition.

- `apps/web/src/__tests__/components/ConversationContextPane.test.tsx`
  - Update if graph selection prop shape changes.

- `e2e/tests/conversations.spec.ts`
  - Add or update branch-switch viewport coverage in the existing desktop and
    mobile branching flows.

### Should Not Change

- `ChatSurface` should not gain branch-specific logic.
- `ForkStrip` should not mutate scroll directly.
- Backend schemas, routes, and services should not change.
- Conversation tree response shape should not change.

### Historical Docs To Update In The Same Cutover

- `docs/chat-workbench-hard-cutover.md`
- `docs/chat-unified-components-hard-cutover.md`

Any acceptance criteria that require branch-switch scroll-to-top must be removed
or replaced. The old behavior must not remain as documented target state.

## Key Details

- Use `useLayoutEffect` for restoration so the user does not see an intermediate
  top position after the path render.
- Use DOM geometry, not message sequence numbers, to preserve visual context.
- Keep anchor helpers deterministic and small.
- Keep all branch-switch entry points routed through `switchToLeaf`.
- Do not depend on CSS scroll anchoring for correctness.
- Do not use `scrollIntoView`; it gives the browser too much positioning
  discretion and can fight the composer dock.
- Preserve `shouldScrollRef` semantics for streaming and sending.
- Keep failure rollback restoring the old viewport, not the attempted target
  viewport.
- Treat browser clamping on short transcripts as acceptable geometry, not an
  application-level top-scroll command.

## Key Decisions

1. **Semantic anchor over raw offset.** Raw `scrollTop` alone is not stable when
   branch content has different heights. Message identity plus visual offset is
   the durable model.
2. **Controller-owned transition.** `ConversationPaneBody` already owns active
   path mutation and rollback, so scroll transition state belongs there.
3. **No scroll-to-top branch.** The old behavior is removed, not conditionalized.
4. **Frontend-only state.** Viewport anchoring is local interaction state and
   does not belong in the backend active-path contract.
5. **One algorithm for all switch sources.** Inline, panel, graph, and mobile
   switches differ only in activation anchor identity.
6. **Reconciliation preserves the live viewport.** Backend truth may replace the
   optimistic path, but it must not replay stale pre-click scroll state or
   introduce a second scroll jump.
7. **Tests define the new contract.** Scroll-to-top tests are deleted or rewritten
   in the same cutover.

## Acceptance Criteria

### Inline Branch Switching

- Activating an enabled inline fork replaces the transcript before
  `/active-path` resolves.
- The scrollport does not become `0` unless it was already at top or browser
  clamping requires it.
- If the top visible message exists in the next path, it remains at the same
  visual offset after the switch.
- If the top visible message does not exist in the next path, the fork parent
  assistant message is used as the anchor.
- Active fork state updates immediately.

### Panel And Graph Switching

- Activating an enabled fork tree row uses the same branch-switch controller as
  inline fork activation.
- Activating an enabled graph leaf uses the same branch-switch controller as
  inline fork activation.
- Tree and graph switches preserve viewport context by semantic anchor when
  possible and otherwise apply the null-anchor rule.
- No tree or graph switch contains direct scroll mutation outside the controller.

### Mobile

- Mobile drawer branch switching closes the drawer and changes the selected path.
- The drawer close does not cause a top jump.
- Mobile uses the same controller-level scroll transition as desktop.

### Reconciliation And Failure

- If `/active-path` returns a different selected path, the backend path replaces
  optimistic state and the viewport remains anchored.
- If `/active-path` fails, the previous selected path and previous viewport are
  restored.
- Typed feedback is shown on failure.
- Branch drafts whose parent is hidden after switch are still suspended.

### Existing Scroll Semantics

- New outgoing messages still scroll to bottom.
- Streaming remains pinned only when the user is near bottom.
- Loading older messages preserves scroll position.
- Jump-to-parent still moves the viewport to the parent message.
- Composer wheel forwarding still scrolls the transcript.

### Tests

- Component tests cover inline switch viewport preservation.
- Component tests cover backend reconciliation without top jump.
- Component tests cover persistence failure restoring previous viewport.
- Component tests cover graph or panel activation anchor handoff if prop shape
  changes.
- E2E coverage verifies at least one real branch switch does not reset the chat
  scrollport to top.
- No remaining test asserts branch-switch `scrollTop === 0`.

## Cutover Sequence

1. Add failing component coverage for stable viewport on branch switch.
2. Add viewport anchor capture and restore helpers.
3. Replace `pendingScrollTopRef` with `pendingBranchScrollRef`.
4. Route inline, panel, graph, and mobile switches through the same transition
   data.
5. Capture and restore the live optimistic viewport during backend
   reconciliation.
6. Preserve previous viewport during rollback.
7. Update E2E branch-switch coverage.
8. Remove or rewrite docs and tests that require scroll-to-top behavior.
9. Run focused frontend tests.
10. Run the relevant E2E conversation branching flow.

## Verification Commands

Run focused checks first:

```sh
cd apps/web
bun test src/__tests__/components/ConversationPaneBody.test.tsx
bun test src/__tests__/components/ConversationContextPane.test.tsx
bun test src/components/chat/ConversationForksPanel.test.tsx
```

Run the browser flow when the implementation touches drawer, graph, or pane
geometry:

```sh
cd e2e
bun playwright test tests/conversations.spec.ts
```

Run broader gates before merge according to normal branch risk:

```sh
make check
make test-unit
```

## Risks

- JSDOM geometry is limited. Tests may need controlled element geometry rather
  than relying on natural layout.
- Backend reconciliation can render a path that does not contain the optimistic
  anchor. The null-anchor rule must be covered.
- Mobile drawer close timing can mask scroll bugs. E2E coverage is required when
  that path changes.
- Loading older messages and branch switching both use layout-time scroll
  restoration. The refs must stay mutually exclusive and explicitly prioritized.

## Completion Criteria

The cutover is complete when:

1. Successful branch switches no longer intentionally scroll to top.
2. Viewport anchoring is shared by all branch switch entry points.
3. Backend reconciliation and rollback preserve viewport expectations.
4. Existing send, stream, load-older, composer wheel, and jump-to-parent scroll
   behavior still pass.
5. Tests encode the new viewport contract.
6. Historical docs no longer describe scroll-to-top as target behavior.
