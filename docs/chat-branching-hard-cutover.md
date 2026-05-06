# Chat Branching Hard Cutover

## Role

This document is the target-state plan for replacing linear hidden chat
alternates with first-class tree-structured chat: one selected path in the main
transcript, visible branch points at assistant messages, and a searchable fork
overview in the existing context side surface.

The implementation is a hard cutover. The final state keeps no arrow-only
alternate navigation, no route-only branch state, no separate-chat fork mode,
no legacy linear prompt-history path for branched conversations, no
backward-compatible branch payload, and no fallback that silently appends a
forked reply to the end of the conversation.

The implementation follows repository rules in `docs/rules/`: business logic
lives in backend services, BFF routes proxy only, finite branch states are
exhaustive, database cleanup is explicit, and every additional code path must
be justified by a real product surface.

## Context

Current chat is a flat sequence:

- `messages` belong to one `conversation_id` and are ordered by monotonic
  `seq`.
- `ChatComposer` can append to an existing conversation or create/resolve a
  scoped conversation.
- `ChatRun` creates one complete user message followed by one pending assistant
  message.
- Prompt assembly loads complete prior messages by `seq < current_user.seq`.
- `ChatSurface` renders one `messages[]` list directly into `MessageRow`.
- The full conversation pane already has a desktop context column and a mobile
  context drawer for linked items.

That shape cannot correctly support "reply to this assistant answer" because a
new reply anchored to an older assistant message would still include unrelated
later messages in prompt history, and the UI would have no durable way to show
which branch is active.

## Goals

1. Make branching a core conversation primitive, not hidden UI state.
2. Let users reply to any complete assistant message and create a fork from
   that point.
3. Let users select part of an assistant answer and create a branch anchored to
   that exact answer quote.
4. Show one selected path in the main transcript.
5. Show visible, compact branch points inline at assistant messages.
6. Let clicking an inline fork preview switch the visible path immediately.
7. Preserve the existing linked-context panel by adding a toggle between
   `Context` and `Forks`.
8. Provide a desktop fork panel and mobile drawer with tree, search, rename,
   delete, and active-path controls.
9. Ensure prompt assembly uses only the selected ancestor path, plus valid
   branch-local memory and attached context.
10. Keep branch state durable, shareable inside the conversation, and safe
    across reload, streaming reconnect, and pagination.
11. Remove the old arrow-through-alternates UX completely.

## Non-Goals

- Do not add "fork as separate chat".
- Do not duplicate a branch into a new conversation as the primary model.
- Do not keep branch navigation only in hover controls.
- Do not render nested full transcripts inside message rows.
- Do not preserve a legacy linear message endpoint for branched conversations.
- Do not support branch feature flags, compatibility wrappers, or mixed old/new
  branch payloads.
- Do not create saved highlights for assistant-answer selections.
- Do not create fake reader/media objects for assistant-answer selections.
- Do not make the fork panel replace linked context; it is a toggle in the same
  surface.
- Do not allow prompt assembly to include messages from sibling branches.

## Final State

Every conversation is a message tree.

- The root path is the first user/assistant exchange chain.
- A user message has exactly one parent assistant message, except the first
  user message, which has no parent.
- An assistant message has exactly one parent user message.
- An assistant message may have many user-child replies. Each additional child
  is a branch.
- A selected path is the chain from the root to the active leaf.
- The main transcript renders only the selected path.
- Assistant messages with multiple user children render an inline fork strip
  showing those child replies.
- The fork strip displays compact, readable user-reply previews with active
  state, branch title when present, and count/status metadata.
- Selecting a fork preview changes the active path and re-renders the main
  transcript from that point forward.
- The conversation pane context column has a toggle:
  - `Context`: existing linked context, memory, and persisted context rows.
  - `Forks`: branch tree, search, rename, delete, and active-path operations.
- Mobile uses the existing chat context drawer shell with the same `Context` /
  `Forks` toggle.

## Target Behavior

### Reply To Assistant Message

1. User hovers or focuses a complete assistant message.
2. Message actions expose `Reply / fork from here`.
3. Activating the action creates a branch draft anchored to that assistant
   message.
4. The composer enters branch-reply mode and shows a compact anchor preview.
5. Sending creates a new user child of the selected assistant message and a
   pending assistant child of that new user message.
6. The active path switches to the new branch immediately after the run is
   created.
7. The parent assistant message now shows the new user reply in its fork strip.

### Inline Fork Strip

1. Assistant messages with zero or one user child show no fork strip.
2. Assistant messages with two or more user children show a compact fork strip
   adjacent to the assistant message.
3. Each fork preview shows:
   - user reply text, one or two lines depending on available width
   - branch title when user-renamed
   - active/current marker
   - assistant status for that branch when the child run is active or errored
   - created date or relative time
4. Long replies are truncated visually and preserve full text in accessible
   labels or details.
5. Clicking a preview switches the selected path.
6. Keyboard users can tab to the fork strip, move through previews, and
   activate a preview without losing transcript focus context.

### Fork Panel

The `Forks` panel is a management and navigation surface.

- It shows a tree rooted at the first message.
- It highlights the active path.
- It provides search over user replies, branch titles, selected assistant-answer
  quotes, and assistant summaries if available.
- It supports branch rename.
- It supports branch delete with explicit confirmation.
- It supports pruning a branch subtree only when no active run is inside that
  subtree.
- It shows active/error/pending status for branch runs.
- It can jump to the parent assistant message in the visible path when that
  parent is on the active path.
- It can switch to a branch whose parent is not currently visible; switching
  updates the selected path and scrolls to the branch point when possible.

### Selecting Part Of An Assistant Answer

1. User selects text inside a complete assistant answer.
2. A compact selection popover appears with one AI-answer action:
   `Branch from selection`.
3. Activating the action creates a branch draft anchored to:
   - the assistant message id
   - exact selected text
   - prefix and suffix when available
   - answer character offsets when the rendered markdown can map selection to
     source content
4. The composer focuses in branch-reply mode.
5. The composer anchor preview shows the selected assistant quote and the
   parent answer metadata.
6. Sending creates a new user child of the selected assistant message and
   persists the quote anchor on the branch edge or user message.
7. Prompt assembly includes the selected answer quote as an explicit branch
   anchor block.

This reuses the existing quote-to-chat interaction pattern: selection popover,
attached-context-style preview, composer focus, remove control, and explicit
visible context before send. It does not reuse saved-highlight persistence.
Assistant-answer selections are not reader selections and are not highlights.
They are message-selection branch anchors.

### Existing Reader Quote-To-Chat

Reader quote-to-chat remains reader-owned.

- Reader selections continue to create reader-selection contexts.
- Reader assistant behavior continues to live in the media secondary rail or
  mobile sheet.
- Full conversation chat can contain reader-selection contexts as message
  context.
- Assistant-answer branch selection uses parallel UI and display patterns, but
  a distinct data model.

## Data Model

Add durable branch/path metadata.

### Messages

Add fields to `messages` or a message-edge table:

- `parent_message_id UUID NULL`
- `branch_root_message_id UUID NULL`
- `branch_anchor_kind TEXT NOT NULL`
- `branch_anchor JSONB NOT NULL DEFAULT '{}'::jsonb`

Rules:

- Root user messages have `parent_message_id IS NULL`.
- Non-root user messages must have an assistant parent.
- Assistant messages must have a user parent.
- `branch_anchor_kind` is one of:
  - `none`
  - `assistant_message`
  - `assistant_selection`
  - `reader_context`
- `assistant_selection` anchors include message id, exact text, optional prefix,
  optional suffix, optional offsets, and created client selection id.
- The data model must enforce enough shape to prevent impossible parent/role
  states. Cross-row role validation belongs in services if a database check
  cannot express it cleanly.

### Conversation Path State

Persist selected path per owner conversation.

Use a table such as `conversation_active_paths`:

- `id UUID PRIMARY KEY`
- `conversation_id UUID NOT NULL`
- `viewer_user_id UUID NOT NULL`
- `active_leaf_message_id UUID NOT NULL`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`

Rules:

- Owner path is the product default.
- Shared readers may have viewer-local selected paths if branch navigation is
  allowed for shared conversations.
- Active leaf must belong to the conversation.
- Active leaf must be on a valid path.

### Branch Metadata

Use a branch metadata table keyed by the user child that starts a branch:

- `id UUID PRIMARY KEY`
- `conversation_id UUID NOT NULL`
- `branch_user_message_id UUID NOT NULL`
- `title TEXT NULL`
- `deleted_at timestamptz NULL`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`

Rules:

- Rename writes `title`.
- Delete is subtree-aware. Hard delete is allowed only if cleanup is explicit
  and no active run depends on the subtree.
- Soft delete is acceptable only as the canonical delete model for branches,
  not as a compatibility fallback.

## API Contracts

### Create Chat Run

Replace append-only creation with anchored creation.

Request fields:

- `conversation_id`
- `parent_message_id`
- `branch_anchor`
- existing model/reasoning/key/web-search/context fields

Rules:

- Existing conversations require `conversation_id`.
- New root conversations use `conversation_scope`.
- Forked sends require `parent_message_id` pointing to a complete assistant
  message in the conversation.
- Root sends have no parent message.
- Backend rejects parent messages that are not complete assistant messages.
- Backend rejects fork sends while a conflicting active run exists in the same
  branch path.
- Backend never silently appends to conversation tail when an anchor is invalid.

### Conversation Read

Replace flat message reads for chat display with a path-aware read contract:

```ts
interface ConversationTreeResponse {
  conversation: ConversationSummary;
  selected_path: ConversationMessage[];
  active_leaf_message_id: string | null;
  fork_options_by_parent_id: Record<string, ForkOption[]>;
  page: { before_cursor: string | null };
}

interface ForkOption {
  id: string;
  parent_message_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  title: string | null;
  preview: string;
  branch_anchor_kind: BranchAnchorKind;
  branch_anchor_preview: string | null;
  status: "complete" | "pending" | "error" | "cancelled";
  message_count: number;
  created_at: string;
  updated_at: string;
  active: boolean;
}
```

Rules:

- The response returns the selected path and branch options needed to render
  visible branch points on that path.
- It does not return sibling full transcripts inline.
- Pagination pages path ancestors, not global `seq` ranges.
- Search in the fork panel has its own endpoint or query mode.

### Branch Operations

Add service-backed operations:

- `GET /conversations/:id/tree`
- `POST /conversations/:id/active-path`
- `GET /conversations/:id/forks`
- `PATCH /conversations/:id/forks/:branch_id`
- `DELETE /conversations/:id/forks/:branch_id`

Next.js BFF routes proxy only. FastAPI route handlers validate request shape
and call services. Services own tree validation, active-path updates, rename,
delete, and cleanup.

## Prompt Assembly

Prompt history is branch-path history.

Rules:

- For a root send, prompt history is empty except durable scope, memory, and
  attached context.
- For a fork send, prompt history is the ancestor chain from root through the
  parent assistant message.
- Sibling branch messages are excluded.
- Later messages on the previous active path are excluded.
- The current user message is rendered after ancestor history and branch anchor
  blocks.
- Assistant-selection branch anchors are rendered as explicit source context:
  "The user branched from this selected part of the previous assistant answer."
- Reader-selection contexts remain mandatory attached context.
- Prompt ledgers persist included ancestor message ids in path order.
- Retrieval planning uses path history, not global recent `seq`.

## Conversation Memory

Conversation memory must become path-aware or be conservatively filtered.

Initial cutover rule:

- Memory items created from messages not on the selected ancestor path are not
  included in prompt assembly.
- State snapshots with `covered_through_seq` alone are not sufficient for branch
  prompts.
- Add path/source refs to memory items or compute memory inclusion from source
  message ancestry.

Acceptance requires tests proving a fork from an old assistant does not include
decisions, corrections, or preferences introduced only in sibling/later branches.

## Frontend Architecture

### Ownership

`ConversationPaneBody` owns:

- loading path-aware conversation data
- active path state
- switching path on fork preview click
- choosing context panel mode: `context` or `forks`
- passing branch metadata to `ChatSurface`

`ChatSurface` owns:

- one named scroll region
- one named message log
- rendering selected-path messages
- passing fork options and message actions to `MessageRow`
- keeping composer after the transcript

`MessageRow` owns:

- assistant message actions
- answer-selection popover target area
- inline fork strip rendering for that assistant message
- accessibility labels for fork previews

`ChatComposer` owns:

- normal message drafting
- branch-reply draft mode display
- branch anchor preview/removal
- posting `parent_message_id` and `branch_anchor`

`ConversationContextPane` owns:

- the `Context` / `Forks` toggle shell on desktop
- existing context view under `Context`
- `ConversationForksPanel` under `Forks`

`ChatContextDrawer` owns:

- the same toggle shell on mobile
- drawer presentation only

`ConversationForksPanel` owns:

- branch tree
- branch search
- rename UI
- delete confirmation UI
- active-path selection UI

### New Frontend Modules

- `apps/web/src/components/chat/ForkStrip.tsx`
- `apps/web/src/components/chat/ForkStrip.module.css`
- `apps/web/src/components/chat/AssistantSelectionPopover.tsx`
- `apps/web/src/components/chat/AssistantSelectionPopover.module.css`
- `apps/web/src/components/chat/BranchAnchorPreview.tsx`
- `apps/web/src/components/chat/BranchAnchorPreview.module.css`
- `apps/web/src/components/chat/ConversationForksPanel.tsx`
- `apps/web/src/components/chat/ConversationForksPanel.module.css`
- `apps/web/src/lib/conversations/branching.ts`
- `apps/web/src/lib/conversations/branching.test.ts`

### Frontend Refactors

- `ConversationPaneBody.tsx`: replace flat message load with tree/path load.
- `ChatSurface.tsx`: accept selected path and fork options.
- `MessageRow.tsx`: add assistant actions, fork strip, and selection handling.
- `ChatComposer.tsx`: add branch anchor request fields and visible anchor
  state.
- `ConversationContextPane.tsx`: add context/forks toggle.
- `ChatContextDrawer.tsx`: add mobile context/forks toggle.
- `useChatRunTail.ts`: merge streamed run messages into the selected path and
  fork option maps, not a global sorted list.
- `useChatMessageUpdates.ts`: update messages by id within selected path.

## Backend Architecture

### Services

Add or extend services in `python/nexus/services/`:

- `conversation_branches.py`
  - path validation
  - active path updates
  - fork option queries
  - tree search
  - branch rename
  - branch delete
- `chat_runs.py`
  - anchored message preparation
  - branch-aware busy checks
  - branch-anchor validation
- `context_assembler.py`
  - path-aware history loading
  - branch-anchor prompt block rendering
- `conversation_memory.py`
  - path-aware memory filtering

### Schemas

Extend `python/nexus/schemas/conversation.py`:

- `BranchAnchorKind`
- `BranchAnchorRequest`
- `BranchAnchorOut`
- `ForkOptionOut`
- `ConversationTreeOut`
- `SetActivePathRequest`
- `RenameBranchRequest`

Use discriminated unions for finite branch-anchor variants and exhaustive
validation. Unknown anchor kinds are request errors.

### Migrations

Add one migration for branch metadata and constraints.

Do not use database-level cascading deletes for new tables. Branch cleanup is
explicit in services.

Add indexes only for required query patterns:

- children by `parent_message_id`
- active path by `(conversation_id, viewer_user_id)`
- branch metadata by `conversation_id`
- fork search support only if the initial search endpoint needs it at scale

## UI Rules

- The main transcript shows exactly one selected path.
- Branch alternatives are visible at the assistant message where they diverge.
- Inline fork previews are compact; they do not become nested chats.
- Every branch-changing action is explicit.
- Branch delete is confirmed and names the affected branch.
- Rename is branch metadata only; it does not mutate message content.
- Assistant answer selection can only branch from complete assistant messages.
- Selection popovers never auto-send.
- The context/forks toggle preserves the current linked-context panel.
- Mobile and desktop expose the same branch inventory and operations.
- The branch panel is not required to be open for branch points to be visible.

## Accessibility

- The transcript remains one `role="log"` inside one named scroll region.
- Fork strips use real buttons or tabs with accessible active state.
- Branch tree uses a navigable tree or listbox pattern with explicit labels.
- Search input owns its result state with predictable focus behavior.
- Rename and delete controls are keyboard reachable.
- Answer-selection popover restores focus predictably after action or dismissal.
- Branch anchor preview has a remove button with a specific label.

## Error Handling

Use typed errors for:

- parent message not found
- parent message not assistant
- parent message incomplete
- parent message outside conversation
- branch path invalid
- active leaf outside conversation
- branch has active run
- branch delete would remove active path
- assistant selection offsets invalid
- selected text no longer maps to answer content

Do not silently fall back to append-to-tail behavior. Do not approximate an
assistant-answer selection. Exact-text-only anchors are valid only when the
request explicitly carries `offset_status: "unmapped"`; otherwise invalid
offsets are rejected with a typed error.

## Files

Frontend:

- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/MessageRow.tsx`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/components/ConversationContextPane.tsx`
- `apps/web/src/components/chat/ChatContextDrawer.tsx`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/api/sse.ts`

Backend:

- `python/nexus/db/models.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/conversation_memory.py`
- `python/nexus/services/seq.py`
- `migrations/alembic/versions/*_chat_branching_hard_cutover.py`

Tests:

- `apps/web/src/__tests__/components/ChatSurface.test.tsx`
- `apps/web/src/components/chat/MessageRow.test.tsx`
- `apps/web/src/__tests__/components/ChatComposer.test.tsx`
- `apps/web/src/__tests__/components/ConversationContextPane.test.tsx`
- `apps/web/src/__tests__/components/ChatContextDrawer.test.tsx`
- `python/tests/test_chat_runs.py`
- `python/tests/test_conversations.py`
- `python/tests/test_chat_prompt.py`
- `python/tests/test_context_assembler.py`
- `python/tests/test_conversation_memory.py`
- `python/tests/test_migrations.py`
- `e2e/tests/conversations.spec.ts`

## Acceptance Criteria

### Product

- User can fork from any complete assistant message.
- User can select part of a complete assistant answer and fork from that quote.
- The selected answer quote is visible before send and can be removed.
- Main transcript shows one selected path.
- Assistant messages with multiple user replies show visible inline fork
  previews.
- Clicking a fork preview switches the selected path.
- The context side surface toggles between existing context and forks.
- Desktop fork panel supports tree, search, rename, delete, and active-path
  switching.
- Mobile drawer supports the same fork inventory and operations.
- No "fork as separate chat" action exists.
- No arrow-only alternate navigation remains.

### Data

- Forked user messages persist their assistant parent.
- Assistant messages persist their user parent.
- Assistant-selection anchors persist exact selected text and available mapping
  metadata.
- Active path persists across reload.
- Branch rename persists without changing message content.
- Branch delete removes or hides the intended subtree and does not leave orphan
  branch metadata.

### Prompt Correctness

- Fork prompts include only ancestor path messages.
- Fork prompts exclude sibling branch messages.
- Fork prompts exclude later messages from the previous active path.
- Assistant-selection branch prompts include the selected answer quote as an
  explicit branch anchor.
- Conversation memory from sibling branches is excluded.

### Streaming

- Creating a forked chat run immediately switches to the new branch path.
- Streaming deltas update the assistant message on the active branch.
- Reconnect/reconcile updates the same branch path.
- Active runs in sibling branches do not corrupt the visible selected path.

### Tests

- Frontend unit tests cover fork strip rendering, path switching, assistant
  message actions, assistant-answer selection branch anchors, branch anchor
  removal, context/forks toggle, fork panel search, rename, delete, and mobile
  drawer behavior.
- Backend tests cover schema validation, parent role validation, anchored run
  creation, path reads, active path persistence, branch search, rename, delete,
  prompt path assembly, memory filtering, and migration constraints.
- E2E tests cover desktop fork from assistant, desktop fork from selected
  assistant quote, inline preview path switching, fork panel search/rename,
  mobile drawer path switching, and streaming on a new fork.

## Cutover Sequence

1. Add database schema and backend models for message parentage, branch anchors,
   active paths, and branch metadata.
2. Replace message creation with anchored message creation in chat runs.
3. Add path-aware prompt history and branch-anchor prompt blocks.
4. Add branch-aware conversation read APIs.
5. Replace frontend flat message state with selected-path state.
6. Add assistant message actions and branch-reply composer mode.
7. Add assistant-answer selection branch anchors.
8. Add inline fork strip and path switching.
9. Add context/forks toggle on desktop and mobile.
10. Add fork tree/search/rename/delete panel.
11. Delete old arrow-only branch navigation and any linear-only branch code.
12. Run TypeScript, frontend unit tests, backend tests, migrations tests, and
    targeted E2E tests.

## Key Decisions

- The product primitive is a conversation tree, not copied conversations.
- The main transcript is a selected path, not all branches.
- Branch points are visible inline at the assistant message where they diverge.
- Branch management lives beside linked context, behind a `Context` / `Forks`
  toggle.
- Assistant-answer selection uses quote-to-chat interaction patterns but a
  distinct message-selection branch-anchor model.
- Prompt assembly is path-aware from the first cutover.
- Conversation memory must be path-aware or conservatively excluded.
- There is no separate-chat fork action.
- There is no backward compatibility path for legacy branch payloads.
