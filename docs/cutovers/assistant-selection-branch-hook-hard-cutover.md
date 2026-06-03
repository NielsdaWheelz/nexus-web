# Assistant Selection Branch Hook Hard Cutover

Status: draft implementation spec
Date: 2026-06-03
Owner: web app / chat surface
Scope: `apps/web` assistant-answer selection, branch-draft construction,
non-modal action-bubble positioning, chat module docs, and focused tests

## 1. Thesis

Assistant answer selection is a branch-anchor capability. It is not a reader
quote-to-chat capability, not a conversation reference capability, and not a
popover-local UI detail.

Today the capability is split incorrectly:

- `AssistantSelectionPopover` is mostly presentational, but it exports the
  assistant-selection draft type.
- `AssistantMessage` owns DOM selection capture, source mapping, prefix/suffix
  derivation, random client selection id creation, branch draft construction,
  popover positioning, branch dispatch, and live selection clearing.
- `lib/conversations/assistantSelection.ts` already owns the pure mapping and
  anchor construction primitives, but not the draft type or full branch-draft
  assembly.
- `Conversation.tsx` and `useChatDraft.ts` duplicate branch-draft key logic.
- Assistant message text is derived locally even though
  `conversationMessageText` is already the canonical text extractor.
- Floating action surfaces repeat positioning, dismissal, and ARIA semantics
  across assistant selection, reader selection, highlight actions, and nested
  color pickers.

The final state is a hard cutover to one assistant-selection branch owner, one
canonical assistant text extractor, one branch-draft identity helper, and one
non-modal floating action surface primitive for action bubbles.

This is a hard cutover:

- no legacy lane
- no compatibility branch
- no old/new dual behavior
- no fallback API shape
- no test-only props or exports
- no route-local or component-local papering over of shared floating UI behavior
- no conflation of `assistant_selection` with `reader_selection`

## 2. Governing Rules And Standards

Repo rules:

- `docs/rules/cleanliness.md`: one owner per concern, collapse repeated
  derivations and state machines, split render/mutation/state bodies, and remove
  fallback/compatibility lanes.
- `docs/rules/module-apis.md`: expose each capability in one primary form and
  reuse existing module capabilities instead of introducing near-duplicates.
- `docs/rules/layers.md`: UI components and hooks may translate browser
  interaction into typed application values; transport and backend validation
  remain outside UI components.
- `docs/rules/control-flow.md`: finite branch-anchor states must be explicit and
  exhaustively handled.
- `docs/rules/testing_standards.md`: selection APIs and interaction-heavy UI
  belong in browser-mode component tests, with E2E covering user-visible flows
  against the real app.
- `docs/architecture.md`: chat is durable, branchable, and grounded; frontend
  chat surfaces live in `components/chat/*` and shared conversation contracts
  live in `lib/conversations/*`.
- `docs/modules/reader-implementation.md`: reader quote-to-chat is
  highlight-first and uses transient `reader_selection`; assistant selection
  must not reuse that contract.

External platform constraints:

- React custom hooks are the correct owner for reusable stateful UI behavior;
  components should stay render-oriented.
- Browser selection and geometry are DOM APIs; they belong in event handlers or
  effects behind refs, not in render-time derivations.
- `Selection` and `Range` are the browser source for selected text and selected
  geometry. Multi-line selections require line rect awareness, not only a single
  bounding rect.
- Non-modal action bubbles should not claim modal-dialog semantics. Modal
  dialogs require focus movement, focus containment, Escape handling, and return
  focus; action bubbles need button semantics, outside/Escape dismissal, and
  stable keyboard access.

## 3. Vocabulary

`assistant_selection`

The branch anchor stored on a user message when the user forks a conversation
from selected text inside a completed assistant answer.

`reader_selection`

The transient, bind-only chat-run input used when the reader quotes a durable
highlight into chat. It carries `media_id` and `highlight_id`, and the backend
canonicalizes the quote from the highlight row.

`BranchDraft`

The frontend composer mode object that says the next send is a fork reply under
a parent assistant message. For assistant selection, its `anchor` is an
`assistant_selection` branch anchor.

`AssistantSelectionTextDraft`

The DOM-free captured selection data before dispatch into the composer. It
includes the exact visible quote, prefix/suffix, mapped or unmapped offset state,
and stable client selection id.

`AssistantSelectionDraft`

The hook-owned UI draft. It contains `AssistantSelectionTextDraft` plus the
selection anchor rect and optional line rects used to place the action surface.

`Floating action surface`

A non-modal, viewport-clamped action bubble anchored to a DOM rect or element.
It is not a menu, not a sheet, and not a modal dialog.

## 4. Target Behavior

### 4.1 Assistant Answer Selection

When a complete assistant message is branchable:

1. Selecting nonblank text wholly inside that assistant answer captures an
   assistant-selection draft.
2. The draft is anchored to the selected range geometry.
3. The visible action surface offers `Fork from selection`.
4. Clicking `Fork from selection` creates exactly one `BranchDraft` whose anchor
   is `assistant_selection`.
5. The composer enters fork-reply mode and shows the selected quote.
6. The browser selection is cleared after dispatch.
7. The draft is dismissed when the live selection leaves the assistant answer,
   collapses outside the retained-selection policy, Escape is pressed, another
   outside pointer target is pressed, or the message becomes unbranchable.

The feature must work with mouse selection and keyboard selection.

The feature must not show for:

- pending assistant messages
- error assistant messages without usable assistant text
- user or system messages
- branch-disabled chat surfaces
- collapsed selections
- selections that start or end outside the assistant answer
- whitespace-only selections

### 4.2 Mapped And Unmapped Anchors

The hook maps selected text against the canonical assistant message text, not
against rendered Markdown as a source of truth.

Mapped selection:

- `offset_status: "mapped"`
- includes `start_offset` and `end_offset`
- exact text at those offsets equals the selected quote
- prefix/suffix are derived from the canonical assistant text around the mapped
  offsets

Unmapped selection:

- `offset_status: "unmapped"`
- includes no offsets
- still includes exact text and best-effort rendered prefix/suffix context
- remains valid for backend prompt context, but not offset-addressable

The implementation must not add fuzzy offset fallback lanes. If the selection is
not uniquely mappable, it is intentionally unmapped.

### 4.3 Branch Dispatch

The hook dispatches a `BranchDraft`, not an API request and not a conversation
reference.

The send path remains:

```text
AssistantMessage
  -> useAssistantSelectionBranch
  -> onReplyToAssistant(BranchDraft)
  -> Conversation branch state
  -> ChatComposer
  -> buildChatRunBody
  -> /api/chat-runs
  -> FastAPI branch-anchor validation
```

### 4.4 Reader Quote-To-Chat Remains Separate

Reader quote-to-chat remains:

```text
Reader DOM selection or PDF selection
  -> create/reuse durable highlight
  -> attach highlight:<id> reference
  -> send transient reader_selection { media_id, highlight_id }
  -> backend resolves canonical quote from highlight row
```

Assistant answer selection never creates highlights, never attaches
`highlight:` references, never sends `reader_selection`, and never writes
conversation references.

### 4.5 Floating Action Surface

All non-modal action bubbles use one primary surface primitive:

- viewport-clamped positioning
- optional line-rect placement for text selections
- `visualViewport` support
- safe-area inset support
- mobile bottom obstruction support
- outside pointer dismissal
- Escape dismissal
- optional scroll dismissal or scroll repositioning
- pointerdown preservation when the caller needs the live selection to survive
  button clicks
- non-modal semantics by default

Non-modal action bubbles must not use `role="dialog"` unless they implement the
modal-dialog contract. A surface wrapping an `ActionBar` should let the action
bar expose the button group. A one-button assistant action surface may expose a
named `role="group"` if the wrapper needs an accessible name.

## 5. Current State And Repetitive Patterns

### 5.1 AssistantMessage Is The Wrong Owner

Current file:

- `apps/web/src/components/chat/AssistantMessage.tsx`

Current responsibilities:

- message rendering
- fork button rendering
- evidence disclosure rendering
- fork strip rendering
- assistant text extraction
- selection state
- DOM selection capture
- `Range` geometry
- rendered context extraction
- source offset mapping
- client selection id creation
- branch draft creation
- popover rendering
- live browser selection clearing

Final state:

- `AssistantMessage` renders the assistant message and wires handlers from a
  hook.
- `AssistantMessage` does not import `createRandomId`.
- `AssistantMessage` does not import `assistantSelectionAnchor`.
- `AssistantMessage` does not call `window.getSelection`.
- `AssistantMessage` does not define `assistantMessageText`.
- `AssistantMessage` does not define `renderedSelectionContext`.

### 5.2 AssistantSelectionPopover Owns Domain Shape

Current file:

- `apps/web/src/components/chat/AssistantSelectionPopover.tsx`

Current issue:

- exports `AssistantSelectionDraft`, even though the draft is a
  branch-selection domain value, not popover chrome.

Final state:

- `AssistantSelectionPopover` receives render-ready props:
  - anchor rect or positioned surface props
  - `onBranch`
  - `onDismiss`
  - disabled/busy state when branch dispatch is in flight
- it does not export domain types
- it does not build or know `BranchDraft`
- it does not know mapped/unmapped offset rules
- it renders the button and delegates positioning/semantics to the shared
  floating action surface

### 5.3 Assistant Text Extraction Is Duplicated

Current owners:

- `apps/web/src/lib/conversations/types.ts` exports `conversationMessageText`
- `AssistantMessage.tsx` locally defines `assistantMessageText`
- `AssistantEvidenceDisclosure.tsx` locally repeats the same block filtering

Final state:

- `conversationMessageText` is the only assistant/user/system text extractor.
- `AssistantMessage`, `AssistantEvidenceDisclosure`, and other chat renderers
  import it directly from `@/lib/conversations/types`.
- No local duplicate text extractor remains.

### 5.4 Branch Draft Identity Is Duplicated

Current owners:

- `Conversation.tsx` derives a branch selection draft key inline.
- `useChatDraft.ts` derives the same branch selection draft key inline.

Final state:

- one helper owns chat draft identity:

```ts
chatDraftKeyFor({
  branchDraft,
  conversationId,
  parentMessageId,
  explicitDraftKey,
  newConversationEmptyPath,
})
```

- both `Conversation.tsx` and `useChatDraft.ts` call this helper.
- `assistant_selection` keys include `client_selection_id`.
- `assistant_message` keys include only the parent message id and message mode.

### 5.5 Floating Action Positioning Is Fragmented

Current patterns:

- `SelectionPopover` implements custom placement with line rects, visual
  viewport, safe area, and mobile obstruction.
- `HighlightActionPopover` uses `useAnchoredPosition` and
  `useDismissOnOutsideOrEscape`.
- `ActionBar` color popover uses `useAnchoredPosition` and
  `useDismissOnOutsideOrEscape`.
- `ActionMenu` uses `useAnchoredPosition` and
  `useDismissOnOutsideOrEscape`.
- `AssistantSelectionPopover` uses raw `position: fixed` plus a transform and no
  shared dismissal.
- `HoverPreview` uses `useAnchoredPosition` but mixes non-modal preview and
  mobile modal-sheet semantics.

Final state:

- `useAnchoredPosition` remains a low-level primitive.
- `useDismissOnOutsideOrEscape` remains a low-level primitive.
- one higher-level `FloatingActionSurface` owns non-modal action-bubble
  composition.
- action bubbles use `FloatingActionSurface` instead of implementing local
  viewport placement or local raw fixed positioning.

This cutover migrates:

- assistant selection action surface
- reader `SelectionPopover`
- `HighlightActionPopover`
- `ActionBar` nested color picker popover

This cutover does not migrate:

- `ActionMenu`, because menu keyboard semantics are different from an action
  bubble
- modal sheets, because they use `useDialogOverlay`, not floating action
  behavior
- `HoverPreview`, because preview behavior and touch modal-sheet behavior are a
  separate capability from command/action bubbles

### 5.6 Non-Modal Action Bubbles Pretend To Be Dialogs

Current issue:

- `SelectionPopover`, `HighlightActionPopover`, `ActionBar` nested popover,
  `HoverPreview`, and `AssistantSelectionPopover` use or imply dialog semantics
  even when they do not move focus, trap focus, or behave modally.

Final state:

- modal surfaces use `useDialogOverlay` and modal dialog semantics.
- menus use `ActionMenu` semantics.
- non-modal action bubbles use `FloatingActionSurface` semantics.
- no non-modal action bubble declares `aria-modal`.
- no non-modal action bubble claims `role="dialog"` unless it implements the
  complete dialog lifecycle.

### 5.7 Busy State Is Fragmented

Current issue:

- reader selection `isCreating` prevents callbacks but leaves some action
  buttons appearing enabled.
- color action busy state disables nested picker options, not always the trigger.

Final state:

- `ActionMenuOption` supports a single disabled/busy contract sufficient for
  action bars and menus.
- create/quote/color actions become disabled or visibly busy while a create or
  mutation is in flight.
- no action handler silently no-ops as the primary busy-state behavior.

## 6. Final Architecture

### 6.1 File Ownership

New files:

- `apps/web/src/components/chat/useAssistantSelectionBranch.ts`
  - React hook for assistant answer selection capture and branch draft dispatch.
- `apps/web/src/components/chat/AssistantMessage.test.tsx`
  - browser-mode component test for selection capture and branch dispatch.
- `apps/web/src/components/ui/FloatingActionSurface.tsx`
  - non-modal action-bubble surface.
- `apps/web/src/components/ui/FloatingActionSurface.module.css`
  - shared surface styling.
- `apps/web/src/components/ui/FloatingActionSurface.test.tsx`
  - browser-mode placement and dismissal tests.
- `apps/web/src/lib/conversations/chatDraftKey.ts`
  - pure draft-key helper.
- `apps/web/src/lib/conversations/chatDraftKey.test.ts`
  - pure draft-key tests.

Changed files:

- `apps/web/src/lib/conversations/assistantSelection.ts`
  - owns assistant selection draft type and pure construction helpers.
- `apps/web/src/lib/conversations/assistantSelection.test.ts`
  - expands pure coverage for mapped/unmapped branch draft construction.
- `apps/web/src/components/chat/AssistantMessage.tsx`
  - becomes a thin renderer/wiring component.
- `apps/web/src/components/chat/AssistantSelectionPopover.tsx`
  - becomes presentational and uses `FloatingActionSurface`.
- `apps/web/src/components/chat/AssistantEvidenceDisclosure.tsx`
  - uses `conversationMessageText`.
- `apps/web/src/components/chat/Conversation.tsx`
  - calls the shared branch draft key helper.
- `apps/web/src/components/chat/useChatDraft.ts`
  - calls the shared branch draft key helper.
- `apps/web/src/components/SelectionPopover.tsx`
  - delegates placement/dismissal to `FloatingActionSurface`.
- `apps/web/src/components/highlights/HighlightActionPopover.tsx`
  - delegates placement/dismissal to `FloatingActionSurface`.
- `apps/web/src/components/ui/ActionBar.tsx`
  - uses the shared surface for nested popovers.
- `apps/web/src/components/highlights/highlightActions.tsx`
  - adds explicit busy/disabled action states.
- `apps/web/src/components/highlights/HighlightActionBar.tsx`
  - passes busy/disabled states through consistently.
- `docs/modules/chat.md`
  - filled with the chat module contract, including assistant selection
    branching and reader quote separation.

Unchanged backend files:

- `python/nexus/schemas/conversation.py`
- `python/nexus/services/conversation_branches.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/chat_run_validation.py`

Backend changes are not expected. If backend changes become necessary, the
frontend spec is wrong or a hidden contract mismatch was discovered.

### 6.2 Assistant Selection Hook Contract

Public API:

```ts
export function useAssistantSelectionBranch(args: {
  message: ConversationMessage;
  assistantText: string;
  enabled: boolean;
  onReplyToAssistant?: (draft: BranchDraft) => void;
}): {
  answerRef: React.RefObject<HTMLDivElement | null>;
  selection: AssistantSelectionDraft | null;
  captureSelection: () => void;
  clearSelection: (options?: { removeLiveSelection?: boolean }) => void;
  branchFromSelection: () => void;
};
```

Rules:

- `enabled` is true only for complete assistant messages with an
  `onReplyToAssistant` callback.
- The hook owns the `answerRef`; callers pass it into
  `AssistantEvidenceDisclosure`.
- The hook reads `window.getSelection()` only inside capture/clear effects or
  event handlers.
- The hook never reads DOM in render.
- The hook does not send network requests.
- The hook does not mutate conversation state except through
  `onReplyToAssistant`.
- The hook does not import reader/highlight modules.
- The hook clears live selection only when it owns the branch dispatch or an
  explicit caller action requests clearing.

### 6.3 Pure Assistant Selection Contract

`lib/conversations/assistantSelection.ts` owns:

- `AssistantSelectionTextDraft`
- `AssistantSelectionMapping`
- `mapAssistantSelectionToSource`
- `assistantSelectionAnchor`
- `assistantSelectionBranchDraft`

Pure helper shape:

```ts
export function assistantSelectionBranchDraft(args: {
  parentMessageId: string;
  parentMessageSeq: number;
  parentMessagePreview: string;
  selection: AssistantSelectionTextDraft;
}): BranchDraft;
```

Rules:

- The pure helper accepts typed values, not DOM nodes.
- It never creates ids. Id creation happens at capture time.
- It never performs fuzzy matching beyond the existing unique exact match.
- It never includes `start_offset` or `end_offset` for unmapped anchors.
- It never produces `reader_selection`.

### 6.4 FloatingActionSurface Contract

Public API:

```ts
export function FloatingActionSurface({
  anchor,
  lineRects,
  open,
  placement,
  align,
  mobileStrategy,
  dismissOnScroll,
  preservePointerSelection,
  label,
  role,
  refs,
  onDismiss,
  children,
}: FloatingActionSurfaceProps): React.ReactNode;
```

The capability contract is:

- `anchor` accepts `DOMRect` or `HTMLElement`.
- `lineRects` is optional and used for text-selection placement.
- `open` gates listeners and rendering.
- placement is clamped to the visual viewport when available.
- safe-area and mobile bottom obstruction are honored.
- outside pointer and Escape are handled by the primitive.
- nested portaled children marked `data-dismiss-ignore` do not dismiss the host.
- pointerdown can be prevented when a live selection must survive a button
  click.
- role defaults to no wrapper role; callers opt into `group`, `toolbar`, or
  `dialog` only when semantically correct.

The primitive is not:

- a modal dialog
- an `ActionMenu`
- a generic layout wrapper
- a compatibility layer around old popovers

### 6.5 Action Busy Contract

`ActionMenuOption` grows one primary disabled/busy representation. The final
shape should be minimal, for example:

```ts
type ActionMenuOption = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
  disabledReason?: string;
  ...
};
```

Rules:

- `busy` implies the action cannot be re-triggered.
- `ActionBar` and `ActionMenu` render busy/disabled consistently.
- quote/create/color actions use the same mechanism.
- handlers do not silently no-op as the only busy guard.

## 7. API Design Decisions

### 7.1 Canonical Assistant Text

Decision:

- `conversationMessageText(message)` is the single source of assistant text.

Reason:

- backend validation compares against `parent_message.content`, and frontend
  message documents are already normalized through this helper elsewhere.

Consequences:

- `AssistantMessage` and `AssistantEvidenceDisclosure` stop deriving text
  locally.
- future message document format changes touch one extractor.

### 7.2 Selection Id Creation

Decision:

- `client_selection_id` is created when a valid draft is captured.

Reason:

- the id is part of branch draft identity and composer draft separation.

Consequences:

- recapturing a different selection creates a different draft key.
- dispatching a retained draft keeps the same id.

### 7.3 Mapping Boundary

Decision:

- exact offset mapping remains strict and unique.

Reason:

- backend validation rejects bad mapped offsets and source drift must surface as
  unmapped, not guessed offsets.

Consequences:

- Markdown rendering differences produce unmapped anchors.
- repeated exact text produces unmapped anchors.
- mapped offsets are included only when exact source validation succeeds.

### 7.4 Positioning Boundary

Decision:

- placement and dismissal are owned by `FloatingActionSurface`, not by assistant
  selection or reader selection components.

Reason:

- positioning is a shared UI primitive with repeated viewport, visual viewport,
  safe area, and dismissal logic.

Consequences:

- `AssistantSelectionPopover.module.css` loses raw fixed-position transform
  responsibility.
- `SelectionPopover` loses custom local placement code after parity is achieved.
- surface tests move to the primitive.

### 7.5 Branch Draft Key Ownership

Decision:

- chat draft identity has one owner.

Reason:

- branch selection identity is currently duplicated in `Conversation.tsx` and
  `useChatDraft.ts`.

Consequences:

- changing branch draft identity rules requires one code change and one test
  update.

### 7.6 Documentation Ownership

Decision:

- `docs/modules/chat.md` gets the durable chat contract.
- this cutover spec remains the implementation plan.

Reason:

- the audit identifies `docs/modules/chat.md` as an empty module-doc gap.
- implementation specs should not become permanent module docs after the
  cutover is done.

Consequences:

- `docs/modules/chat.md` must describe final ownership once implemented.
- stale implementation-era details must not be copied into the module doc.

## 8. Non-Goals

This cutover does not:

- change backend branch-anchor schemas
- change FastAPI branch-anchor validation
- change chat-run body transport shape
- create or change conversation reference APIs
- change reader quote-to-chat semantics
- merge `assistant_selection` and `reader_selection`
- rewrite `useConversation` into all proposed sub-hooks
- implement retained reader selection hook extraction beyond the narrow adapter
  needed for `FloatingActionSurface`
- solve all reflowable highlight keyboard accessibility gaps
- migrate modal sheets to `FloatingActionSurface`
- preserve the old assistant popover API

## 9. Acceptance Criteria

### 9.1 Ownership

- `AssistantSelectionDraft` is not exported from
  `AssistantSelectionPopover.tsx`.
- `AssistantSelectionPopover.tsx` contains no branch-anchor mapping logic.
- `AssistantMessage.tsx` contains no local assistant text extractor.
- `AssistantMessage.tsx` contains no `window.getSelection()` call.
- `AssistantMessage.tsx` contains no `Range` context helper.
- `AssistantMessage.tsx` contains no `createRandomId` import.
- `AssistantMessage.tsx` contains no `assistantSelectionAnchor` import.
- `AssistantMessage.tsx` uses `useAssistantSelectionBranch`.
- `AssistantEvidenceDisclosure.tsx` uses `conversationMessageText`.
- branch draft key derivation exists in one owner only.

### 9.2 Behavior

- selecting text inside a complete assistant answer shows the selection branch
  action.
- selecting text outside the assistant answer does not show the action.
- selecting whitespace-only text does not show the action.
- selecting repeated or rendered-different text creates an unmapped
  `assistant_selection` anchor.
- selecting unique source text creates a mapped `assistant_selection` anchor with
  offsets.
- `Fork from selection` dispatches one `BranchDraft` with the retained selection
  id.
- after dispatch, the browser selection is cleared and the action surface is
  closed.
- plain `Fork from this answer` still creates an `assistant_message` branch
  draft.
- branch draft composer mode still sends the exact `assistant_selection` anchor
  through `buildChatRunBody`.
- reader quote-to-chat still creates or reuses a highlight before sending
  `reader_selection`.

### 9.3 Floating UI

- assistant selection uses shared floating action surface positioning.
- reader selection and highlight action popovers use the same surface or a
  documented lower-level primitive path with no duplicated placement logic.
- no non-modal action bubble uses `aria-modal`.
- no non-modal action bubble uses `role="dialog"` unless it implements dialog
  focus behavior.
- Escape dismisses assistant selection.
- outside pointer dismisses assistant selection.
- nested color picker interaction does not dismiss its host action surface.
- pointerdown on a selection action does not destroy a needed live text
  selection before the handler runs.
- busy create/quote/color actions render disabled or busy through the action
  option model.

### 9.4 Documentation

- `docs/modules/chat.md` documents:
  - chat engine/view/adapter split
  - branch draft ownership
  - assistant answer selection as branch-anchor context
  - reader quote-to-chat as highlight-first context
  - where `buildChatRunBody` owns request assembly
  - where backend branch-anchor validation happens
- this cutover spec remains accurate after implementation or is updated during
  implementation.

### 9.5 Tests

- pure assistant selection tests cover mapped, unmapped, repeated exact, and
  rendered/source mismatch cases.
- browser component tests cover assistant message selection capture and branch
  dispatch.
- browser component tests cover Escape and outside dismissal for assistant
  selection.
- floating surface tests cover viewport clamping, line-rect placement, nested
  dismiss-ignore, and pointerdown selection preservation.
- existing composer tests still prove branch anchors are sent verbatim.
- E2E still proves selecting assistant text and sending a fork reply works in
  the real app.

## 10. Implementation Sequence

### Phase 0 - Test First

Add failing tests before moving behavior:

1. `AssistantMessage.test.tsx`
   - render a complete assistant message with branch callback
   - create a real selection inside the assistant body
   - trigger mouse and keyboard capture paths
   - assert `Fork from selection` appears
   - click it
   - assert `onReplyToAssistant` received a `BranchDraft`
   - assert mapped/unmapped payload shape for deterministic fixture text

2. `FloatingActionSurface.test.tsx`
   - rect anchor below/above/side placement
   - line rect placement for multi-line selections
   - visual viewport clamping
   - Escape dismissal
   - outside pointer dismissal
   - nested `data-dismiss-ignore`
   - pointerdown default prevention when enabled

3. `chatDraftKey.test.ts`

Do not rely on E2E alone for the hook extraction.

### Phase 1 - Canonicalize Assistant Text

1. Replace `AssistantMessage.assistantMessageText` with
   `conversationMessageText`.
2. Replace duplicate block filtering in `AssistantEvidenceDisclosure` with
   `conversationMessageText`.
3. Confirm no other local duplicate extractor remains in chat components.

No behavior change is intended in this phase.

### Phase 2 - Move Assistant Selection Domain Types

1. Move `AssistantSelectionDraft` out of `AssistantSelectionPopover.tsx`.
2. Put DOM-free draft pieces and mapping types in
   `lib/conversations/assistantSelection.ts`.
3. Keep DOM-only rect fields in `useAssistantSelectionBranch.ts` as
   `AssistantSelectionDraft`.
4. Add the pure `assistantSelectionBranchDraft` helper.

Delete the old popover export. Do not re-export it through a compatibility
barrel.

### Phase 3 - Add useAssistantSelectionBranch

1. Create the hook.
2. Move selection state from `AssistantMessage` into the hook.
3. Move `renderedSelectionContext` into the hook or a hook-private helper.
4. Move branch draft construction into the hook through the pure helper.
5. Move live selection clearing into the hook.
6. Expose render/event props back to `AssistantMessage`.
7. Keep `AssistantMessage` responsible only for rendering and handler wiring.

Delete all old inline selection code from `AssistantMessage`.

### Phase 4 - Add FloatingActionSurface

1. Extract shared placement behavior from `SelectionPopover` and
   `useAnchoredPosition` into a higher-level action surface.
2. Preserve the existing reader selection placement contract:
   - desktop above/below based on available space
   - mobile line-rect preference
   - visual viewport support
   - safe area support
   - mobile bottom obstruction support
3. Preserve existing outside/Escape dismissal behavior.
4. Preserve `data-dismiss-ignore` nested layer behavior.
5. Migrate `AssistantSelectionPopover`.
6. Migrate `SelectionPopover`.
7. Migrate `HighlightActionPopover`.
8. Migrate `ActionBar` nested color picker and preserve action button focus plus
   nested dismiss semantics.

Delete old duplicated placement code after parity tests pass. Do not leave a
local fallback path behind.

### Phase 5 - Normalize Action Semantics And Busy State

1. Extend `ActionMenuOption` with the minimal busy/disabled shape.
2. Update `ActionBar` and `ActionMenu` render paths.
3. Update `buildHighlightActions` so quote/color/create actions represent busy
   state explicitly.
4. Update `SelectionPopover` and `HighlightActionBar` tests.

No action handler should rely on silent no-op as the visible busy behavior.

### Phase 6 - Centralize Branch Draft Keys

1. Create or choose the single draft-key owner.
2. Replace the duplicated branch-selection key logic in `Conversation.tsx`.
3. Replace or preserve the `useChatDraft` usage through the same owner.
4. Add pure tests for:
   - empty new conversation key
   - path continuation key
   - assistant message branch key
   - assistant selection branch key using `client_selection_id`

### Phase 7 - Update Chat Module Docs

Fill `docs/modules/chat.md` with the final module contract:

- `useConversation` current role and future split direction
- `ChatSurface` scroll/view ownership
- `Conversation` and `ReaderChatDetail` adapter roles
- `BranchDraft` and branch-anchor send path
- assistant answer selection path
- reader quote-to-chat path
- `buildChatRunBody` request assembly ownership
- backend validation anchors

Do not copy temporary cutover steps into the module doc.

### Phase 8 - Verification

Run focused checks:

```sh
cd apps/web && bun run test:unit -- \
  src/lib/conversations/assistantSelection.test.ts \
  src/lib/conversations/chatRunBody.test.ts \
  src/lib/conversations/chatDraftKey.test.ts \
  src/components/highlights/highlightActions.test.ts
```

```sh
cd apps/web && bun run test:browser -- \
  src/components/chat/AssistantMessage.test.tsx \
  src/components/ui/FloatingActionSurface.test.tsx \
  src/__tests__/components/SelectionPopover.test.tsx \
  src/components/highlights/HighlightActionPopover.test.tsx \
  src/__tests__/components/ChatComposer.test.tsx
```

```sh
cd apps/web && bun run lint && bun run typecheck
```

Backend focused contract checks:

```sh
./scripts/with_test_services.sh sh -c 'make _test-back-db-ready && cd python && NEXUS_ENV=test uv run pytest -v --tb=short tests/test_chat_runs.py::TestChatRunCreate::test_create_run_anchored_to_complete_assistant_persists_branch_path tests/test_chat_runs.py::TestChatRunCreate::test_create_run_rejects_invalid_assistant_selection_anchor tests/test_reader_selection.py'
```

E2E smoke for the user-visible flow:

```sh
PLAYWRIGHT_ARGS="tests/conversations.spec.ts tests/quote-attach-references.spec.ts --project=chromium" make test-e2e
```

Do not use `make verify` for this cutover unless explicitly requested. The
focused tests cover the touched contracts more directly.

## 11. Failure Modes To Guard Against

- The hook maps against rendered Markdown and backend rejects mapped offsets.
- Branch draft id changes after capture and composer draft state is lost.
- Selecting text in one assistant message opens the action surface for another.
- Selection action click clears the browser selection before the draft is built.
- Unmapped anchors accidentally include `start_offset` or `end_offset`.
- Reader quote-to-chat starts sending `assistant_selection` or assistant
  selection starts sending `reader_selection`.
- `SelectionPopover` mobile placement regresses while centralizing the surface.
- Nested color picker clicks dismiss the parent action surface.
- Non-modal action bubbles keep `role="dialog"` without focus management.
- Tests assert internal hook wiring instead of user-visible selection and branch
  behavior.

## 12. SME Implementation Checklist

- Start from tests for assistant selection capture and floating surface behavior.
- Move pure assistant-selection domain logic before moving React state.
- Keep DOM selection code in the hook, not in `lib/conversations`.
- Keep transport assembly in `buildChatRunBody`.
- Keep backend contracts unchanged.
- Delete old selection state from `AssistantMessage` in the same patch that adds
  the hook.
- Delete old fixed-position assistant popover styling after the shared surface is
  active.
- Delete duplicate branch draft key code after the shared key owner is active.
- Update `docs/modules/chat.md` after final code shape is known.
- Run targeted unit, browser, backend, and E2E checks.

## 13. Final State Summary

The final system has these owners:

- `lib/conversations/types.ts`: canonical message text extraction and typed chat
  contract shapes.
- `lib/conversations/assistantSelection.ts`: pure assistant-selection mapping
  and branch-anchor construction.
- `components/chat/useAssistantSelectionBranch.ts`: DOM selection capture and
  assistant-selection branch draft lifecycle.
- `components/chat/AssistantMessage.tsx`: assistant message rendering and hook
  wiring.
- `components/chat/AssistantSelectionPopover.tsx`: presentational fork action.
- `components/ui/FloatingActionSurface.tsx`: non-modal floating action surface
  placement and dismissal.
- `components/highlights/*`: highlight action descriptors and action rendering,
  using the shared busy/disabled option model.
- `lib/conversations/chatRunBody.ts`: chat-run request body assembly.
- FastAPI schemas/services: strict validation and prompt rendering for
  `assistant_selection` and `reader_selection`.

The result is a narrow branch-selection capability with no compatibility lane,
no duplicate derivations, no component-owned business contract, and no UI
surface pretending to be a modal dialog.
