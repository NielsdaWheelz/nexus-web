# Chat Response Retry Hard Cutover

## Status

Target plan.

This document owns the user-visible retry contract for failed chat assistant
responses in full conversation chat and reader Ask chat.

The cutover is hard. There is no feature flag, no compatibility mode, no
frontend-only resend path, no in-place failed-run mutation, no legacy stuck
state, and no fallback behavior that asks the user to manually copy the prompt
into the composer.

## Problem

When an assistant response fails, the transcript can render two different error
messages:

- assistant content persisted by the failed run, such as
  `An unexpected error occurred. Please try again.`
- frontend failure feedback, such as `The response failed.`

The failed assistant row is terminal, but the prompt that caused it has no
first-class recovery action. In an existing conversation, this can leave the
composer unable to continue cleanly because new sends require a complete
assistant parent. A failed first assistant response is the worst case: there is
no complete assistant leaf, so the conversation can feel permanently stuck.

The product needs a durable retry action that regenerates the answer to the same
user prompt without relying on stale UI state, manual prompt copy, or implicit
composer behavior.

## Goals

- Add a visible `Retry` action for user prompts whose selected assistant
  response failed with a retryable response error.
- Make retry a backend-owned durable chat-run operation.
- Preserve the original prompt, model, reasoning effort, key mode, web-search
  options, branch anchor, parent, and context snapshots.
- Create a new user-message and assistant-message pair for every accepted retry.
- Preserve the failed run and failed assistant message as immutable terminal
  history.
- Switch the active selected path to the new pending assistant response.
- Stream the new retry attempt through the existing chat-run tail pipeline.
- Support failed root responses and failed follow-up responses.
- Prevent duplicate retry attempts from double-clicks, browser repeats, and
  reconnect races with `Idempotency-Key`.
- Render one clear terminal error state, not duplicated generic error prose.
- Use typed retry eligibility and typed endpoint errors.
- Keep retry transport separate from stream reconnect/resume.
- Cover full conversation chat and reader Ask chat with the same response retry
  contract.

## Non-Goals

- Do not add automatic unbounded provider retries.
- Do not retry cancelled runs.
- Do not add a `Continue` action for truncated or incomplete responses.
- Do not add model switching from the retry button.
- Do not let the retry button edit prompt text, context, model, reasoning, key
  mode, or web-search options.
- Do not mutate a failed assistant message back to `pending`.
- Do not delete failed messages during retry.
- Do not overwrite later branch history.
- Do not add a legacy route that retries by replaying current composer state.
- Do not add compatibility code for pre-chat-run historical messages.
- Do not show retry for nonretryable validation/configuration failures that
  cannot succeed with unchanged inputs.

## Hard-Cutover Policy

- No feature flags.
- No environment toggles.
- No query toggles.
- No old/new component branches.
- No compatibility wrapper around the current stuck behavior.
- No frontend fallback that reconstructs a chat-run create request from rendered
  message state.
- No duplicate error presentation.
- No hidden fallback to composer send when retry endpoint rejects.
- Rewrite or delete tests that assert the old failed-row behavior.
- Update docs that describe terminal chat failure without user recovery.

## Final State

Failed assistant responses are terminal, visible, and recoverable when retryable.

The selected transcript path shows the user prompt and the failed assistant
error. The user prompt row owns a compact `Retry` action when the failed
assistant child is retryable. Activating `Retry` calls a backend endpoint with
the failed assistant message id and an idempotency key.

The backend validates ownership, message role, message status, source run state,
and retry eligibility. It clones the original source run inputs from persisted
server state, creates a new durable chat run, creates a new user message with the
same prompt under the same parent, creates a new pending assistant message under
that new user message, persists the new assistant as the active leaf, enqueues
the chat-run job, commits, and returns the normal `ChatRunResponse`.

The frontend handles that response exactly like a newly created chat run:

- merge returned user and assistant messages into local conversation state
- select the new active path
- start `useChatRunTail` for the returned run id
- disable retry while the retry request is in flight
- render stream deltas through existing message update logic

The failed assistant message remains in history as a prior branch/version. It is
not hidden globally, rewritten, deleted, or changed to pending.

## Target Behavior

### Failed First Response

1. The user sends the first prompt in a new conversation.
2. The assistant run exhausts backend execution and finalizes as `error`.
3. The transcript shows one terminal failure notice.
4. The prompt row shows `Retry` when the failure is retryable.
5. Activating `Retry` creates a new root user message in the same conversation.
6. A new pending assistant message is created under that new user message.
7. The conversation active leaf becomes the new pending assistant.
8. Streaming starts for the new run.
9. The composer is no longer stuck without a complete assistant parent once the
   retry completes.

### Failed Follow-Up Response

1. A complete assistant message exists as the branch parent.
2. The user sends a follow-up prompt.
3. The assistant response fails.
4. The failed prompt row shows `Retry` when the failed assistant child is
   retryable.
5. Activating `Retry` creates a sibling user message under the same complete
   assistant parent.
6. The sibling user message has the same content, branch anchor, and context
   snapshots as the failed source user message.
7. A new pending assistant message is created under the sibling user message.
8. The selected path switches to the retry branch.

### Reader Ask Retry

1. Reader Ask uses the same failed assistant retry endpoint.
2. Retry preserves the reader/media context snapshots from the failed source
   user message.
3. Retry does not read current selection, current media scroll position, current
   composer context, or mutable reader UI state.
4. The reader assistant pane handles the returned `ChatRunResponse` through the
   same run-created path used by normal sends.

### Nonretryable Failure

1. The assistant error remains visible.
2. The prompt row does not show `Retry`.
3. The endpoint rejects direct calls for nonretryable failures.
4. The rejection is typed and does not mutate messages, active leaf, branch
   metadata, or run state.

### Double Click And Repeat Requests

1. The first retry request creates one new run.
2. A repeated request with the same `Idempotency-Key` and same failed assistant
   id returns the same retry run.
3. A repeated request with the same `Idempotency-Key` and different failed
   assistant id is rejected as an idempotency mismatch.
4. No double-click path can create two retry runs for the same click intent.

### Stream Boundary

Retry is not stream resume.

- If a run is still active and the stream disconnects, `useChatRunTail` owns
  reconnect/reconcile.
- If a run is terminal `error`, reconnect is finished and user-visible retry
  owns creating a new run.
- Retry never appends new deltas to the failed run's stream.

## Product Rules

- A failed response is terminal.
- A retry is a new attempt, not a mutation of the failed attempt.
- The visible retry action belongs to the user prompt row.
- The endpoint target is the failed assistant message id.
- The service implementation is run-backed.
- The backend is the source of truth for retry eligibility.
- Retrying preserves the source run's persisted inputs.
- Retrying does not inspect current composer state.
- Retrying does not inspect current reader selection state.
- A retryable prompt must be recoverable even when there is no complete
  assistant leaf in the conversation.
- One click intent creates at most one retry run.
- Error UI must include an action when recovery is possible.
- Error UI must not render duplicate generic failure copy.

## Architecture

### Endpoint

Add one backend endpoint:

```text
POST /messages/{assistant_message_id}/retry
```

Add one Next proxy route:

```text
POST /api/messages/[messageId]/retry
```

The endpoint requires:

- authenticated viewer
- `Idempotency-Key` header
- `assistant_message_id` identifying a failed assistant message

The endpoint returns the existing `ChatRunResponse` shape:

```ts
{
  data: {
    run: ChatRun;
    conversation: ConversationSummary;
    user_message: ConversationMessage;
    assistant_message: ConversationMessage;
  }
}
```

There is no separate retry response schema.

### Backend Ownership

`python/nexus/services/chat_runs.py` owns retry creation because it already owns:

- durable chat-run creation
- idempotency locking
- prompt/context preparation
- assistant pending message creation
- active leaf persistence
- chat-run event creation
- queue dispatch
- chat-run response construction

The route layer only validates HTTP shape, reads `Idempotency-Key`, calls the
service, and returns `success_response`.

### Retry Service

Add a service entry point:

```py
def retry_failed_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    ...
```

The service performs these steps in one transaction:

1. Normalize and validate `Idempotency-Key`.
2. Load and lock any existing run for the same owner/key.
3. Load the failed assistant message and source chat run.
4. Validate ownership, conversation ownership, assistant role, assistant
   `status == "error"`, source run terminal `status == "error"`, and retryable
   error code.
5. Load the source user message.
6. Compute a retry payload hash that includes:
   - operation kind: `chat_response_retry`
   - failed assistant message id
   - source run id
   - source conversation id
   - source user message id
   - source user parent message id
   - source prompt content
   - source model id
   - source reasoning
   - source key mode
   - source web-search options
   - source context snapshot identities and payloads
7. If the owner/key already exists, require the same retry payload hash and
   return the existing retry run.
8. Create a new user message under the same parent as the source user message.
9. Copy source user message branch metadata.
10. Copy source user message context snapshots.
11. Create a new pending assistant message under the new user message.
12. Persist the new assistant message as the active leaf.
13. Create a new `ChatRun` with source run settings and retry payload hash.
14. Append the normal `meta` event.
15. Enqueue the normal `chat_run` job with `dedupe_key=f"chat_run:{run.id}"`.
16. Commit.
17. Return `build_chat_run_response(...)`.

Retry must not call the public `create_chat_run` path because existing
conversation root retry intentionally allows `parent_message_id = None`, while
normal existing-conversation sends require a complete assistant parent.

### Retry Eligibility

The backend defines one retryable error-code set for assistant response retry.

Initial retryable set:

- `E_INTERNAL`
- `E_LLM_PROVIDER_DOWN`
- `E_LLM_TIMEOUT`
- `E_LLM_RATE_LIMIT`
- `E_LLM_INTERRUPTED`
- `E_RATE_LIMITED`
- `E_RATE_LIMITER_UNAVAILABLE`

Nonretryable examples:

- `E_CONTEXT_TOO_LARGE`
- `E_LLM_CONTEXT_TOO_LARGE`
- `E_LLM_BAD_REQUEST`
- `E_LLM_INVALID_KEY`
- `E_LLM_NO_KEY`
- `E_MODEL_NOT_AVAILABLE`
- `E_LLM_INCOMPLETE`

`E_LLM_INCOMPLETE` is excluded from this retry cutover because its correct
product action is continuation or a larger output budget, not an unchanged
retry. That action is a separate cutover.

### Message Output Capability

`MessageOut` gains a backend-computed field:

```py
can_retry_response: bool = False
```

`ConversationMessage` gains the matching frontend field:

```ts
can_retry_response: boolean;
```

Rules:

- The field is `true` only on assistant messages.
- It is `true` only when the assistant message has `status == "error"` and a
  retryable source run.
- It is `false` for user, system, pending, complete, cancelled, missing-run, and
  nonretryable-error messages.
- The frontend does not maintain its own retryable error-code list for deciding
  whether to show `Retry`.
- The endpoint still performs the same validation because UI state is not a
  security boundary.

### Frontend Ownership

`ConversationPaneBody` owns full-chat retry execution because it already owns:

- conversation message state
- selected path state
- active leaf state
- run-created handling
- chat-run tail startup
- feedback presentation

`ReaderAssistantPane` owns reader Ask retry execution for the same reason in the
reader pane.

`ChatSurface` owns mapping visible failed assistant messages to their parent
user rows and passing retry props down the render tree.

`MessageRow` remains role dispatch.

`UserMessage` renders the prompt and the retry affordance.

`AssistantMessage` renders assistant content and terminal assistant feedback,
but does not own the retry button.

### Frontend Flow

1. `ChatSurface` scans the selected visible messages.
2. For every assistant message with `can_retry_response === true`, it records:
   - `parent_message_id` as the user message that owns the visible retry action
   - assistant message `id` as the retry endpoint target
3. `ChatSurface` passes retry metadata to `MessageRow`.
4. `MessageRow` passes retry metadata to `UserMessage`.
5. `UserMessage` renders `Retry` with a retry/refresh icon and accessible label.
6. Activating the button calls the owner-provided retry handler with the failed
   assistant message id.
7. The owner posts to `/api/messages/${assistantMessageId}/retry` with a fresh
   `Idempotency-Key`.
8. The owner reuses the existing chat-run-created handler with the response.
9. The owner starts tailing the returned run id.

### Error Rendering

Assistant error rows render terminal feedback from status/error code.

Rules:

- Do not render generic backend failure text as normal assistant prose for
  error-only rows.
- If partial assistant content exists, render the partial content and then the
  terminal failure notice.
- If no partial assistant content exists, render only the terminal failure
  notice.
- Keep `E_LLM_INCOMPLETE` labeled as an incomplete response, without the retry
  button from this cutover.
- Use `toFeedback()` for retry endpoint failures.
- Do not display raw `ApiError.message` strings in components.

## Data And State

### New Messages

A retry creates:

- a new complete user message
- a new pending assistant message
- a new queued chat run

The source failed user and failed assistant messages remain unchanged.

### Parentage

For a failed root response:

```text
old root user -> old failed assistant
new root user -> new pending assistant
```

For a failed follow-up response:

```text
complete assistant parent
  old user -> old failed assistant
  new user -> new pending assistant
```

The new user message copies the source user message content and context
snapshots. It uses the same parent as the source user message.

### Branch Metadata

Retry copies the source user message branch metadata:

- `branch_root_message_id`
- `branch_anchor_kind`
- `branch_anchor`

When the source user message has a parent assistant, retry also preserves branch
metadata through the existing branch metadata helpers.

### Context Snapshots

Retry copies persisted context snapshots from the source user message. It does
not rebuild contexts from current UI state.

The copy must preserve the context payload that the failed run actually used,
including reader/media/library object references and selected snippets.

### Active Leaf

Retry persists the new assistant message as the active leaf in the same
transaction that creates the run.

The active path returned to the frontend must contain the new retry attempt.

## Key Decisions

- Endpoint is message-addressed and run-backed.
- Retry action appears on the user prompt row, but the endpoint target is the
  failed assistant message id.
- Retry creates a new attempt branch instead of mutating the failed assistant.
- Backend clones persisted source inputs; frontend never reconstructs the
  request.
- `MessageOut.can_retry_response` is the UI display contract.
- `ChatRunResponse` is reused for retry.
- Existing stream reconnect remains transport recovery; retry remains terminal
  failure recovery.
- Root retry intentionally bypasses normal existing-conversation send parent
  validation.
- No compatibility code is added for historical messages that do not have a
  source `ChatRun`.

## Files

### Backend

- `python/nexus/api/routes/conversations.py`
  - add `POST /messages/{message_id}/retry`
- `python/nexus/services/chat_runs.py`
  - add retry service
  - add retry payload hash
  - add retry eligibility helper
  - add context-copy helper or reuse existing context insert helpers
  - update message response construction to include retry capability
- `python/nexus/schemas/conversation.py`
  - add `MessageOut.can_retry_response`
- `python/nexus/db/models.py`
  - no schema change expected
- `python/tests/test_chat_runs.py`
  - add retry service/API coverage
- `python/tests/test_conversations.py`
  - add message output capability coverage if not covered through chat-run tests

### Frontend

- `apps/web/src/app/api/messages/[messageId]/retry/route.ts`
  - proxy to FastAPI retry endpoint
- `apps/web/src/lib/conversations/types.ts`
  - add `ConversationMessage.can_retry_response`
- `apps/web/src/components/chat/ChatSurface.tsx`
  - map failed retryable assistant messages to user-row retry actions
- `apps/web/src/components/chat/MessageRow.tsx`
  - pass retry props to `UserMessage`
- `apps/web/src/components/chat/UserMessage.tsx`
  - render retry action and busy state
- `apps/web/src/components/chat/AssistantMessage.tsx`
  - suppress duplicate generic error prose for error-only rows
- `apps/web/src/components/chat/MessageRow.module.css`
  - style compact user-message action if needed
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - implement full-chat retry handler
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`
  - implement reader Ask retry handler
- `apps/web/src/components/chat/MessageRow.test.tsx`
  - add retry affordance tests
- `apps/web/src/components/chat/ChatStreamingHardCutover.test.tsx`
  - add retry run-created/tailing tests

## Implementation Sequence

1. Backend retry eligibility and message output capability.
2. Backend retry endpoint and service.
3. Backend retry tests.
4. Next proxy route.
5. Frontend type update and retry prop plumbing.
6. Full conversation retry handler.
7. Reader Ask retry handler.
8. Error rendering cleanup.
9. Frontend component and streaming tests.
10. Remove or rewrite tests that encode duplicate error copy or stuck behavior.

## Acceptance Criteria

- A failed first assistant response shows one terminal failure notice.
- A failed first assistant response shows `Retry` on the prompt row when
  retryable.
- Retrying a failed first response creates a new root user message and pending
  assistant message in the same conversation.
- Retrying a failed first response switches the active path to the new pending
  assistant.
- Retrying a failed follow-up response creates a sibling user branch under the
  same complete assistant parent.
- Retrying preserves prompt content, model id, reasoning, key mode, web-search
  options, branch metadata, and context snapshots.
- Retrying starts the existing chat-run tail for the returned run id.
- Repeating the same retry request with the same `Idempotency-Key` returns the
  same retry run.
- Reusing the same `Idempotency-Key` for a different failed assistant message is
  rejected.
- Non-owner retry attempts are rejected without leaking message existence.
- Pending, complete, cancelled, system, user, and nonretryable assistant
  messages cannot be retried.
- Retry endpoint rejection does not mutate messages, runs, branches, active leaf,
  or context snapshots.
- Reader Ask retry uses the same endpoint and preserves reader context snapshots.
- `AssistantMessage` no longer renders both generic backend failure prose and
  frontend failure feedback for error-only rows.
- The retry button is keyboard reachable, has an accessible name, and is disabled
  while its request is in flight.
- There is no feature flag, fallback route, legacy resend path, or old stuck
  behavior left in the implementation.

## Test Matrix

### Backend

- `POST /messages/{assistant_id}/retry` accepts retryable failed root response.
- `POST /messages/{assistant_id}/retry` accepts retryable failed follow-up
  response.
- Retry clones source run settings.
- Retry clones source user message context snapshots.
- Retry copies branch metadata.
- Retry persists new active leaf.
- Retry appends meta event and enqueues exactly one `chat_run` job.
- Same idempotency key and same failed assistant returns same run.
- Same idempotency key and different assistant rejects.
- Complete assistant rejects.
- Pending assistant rejects.
- Cancelled assistant rejects.
- Nonretryable error code rejects.
- Missing source run rejects.
- Non-owner request is masked as not found.

### Frontend

- `Retry` renders on the user row when the selected failed assistant child has
  `can_retry_response`.
- `Retry` does not render for nonretryable failed assistant children.
- `Retry` does not render for complete, pending, cancelled, or incomplete
  assistant children.
- Clicking `Retry` posts to `/api/messages/{assistantId}/retry` with an
  `Idempotency-Key`.
- Retry busy state disables only the clicked retry action.
- Retry response is merged through the existing run-created path.
- Retry starts tailing the returned run id.
- Retry endpoint errors use typed feedback.
- Error-only assistant rows do not render duplicate generic error text.

### End-To-End

- Seed or force a failed first response.
- Click retry on the prompt row.
- Observe a new pending assistant response.
- Let the run complete.
- Confirm the conversation can continue normally from the completed retry
  response.

## Done State

The user can recover from a retryable failed LLM response without editing the
prompt, copying text, refreshing the page, or starting a new conversation. The
retry is durable, idempotent, branch-safe, context-preserving, and streamed
through the existing chat-run pipeline.
