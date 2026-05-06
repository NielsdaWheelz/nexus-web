# Chat Streaming Hard Cutover

## Status

Implemented frontend hard cutover.

This cutover makes every chat send feel immediate, durable, and streamed across
desktop and mobile. The final state keeps the existing durable chat-run model
and direct FastAPI SSE transport, but replaces brittle route-dependent and
one-shot recovery behavior with one shared chat runtime for full conversation
panes, new conversation panes, reader assistant panes, and mobile sheets.

The implementation is a hard cutover. The final state keeps no legacy new-chat
route handoff, no route-only first-send flow, no client polling fallback, no
buffered BFF stream proxy, no compatibility branch for non-streaming assistant
responses, and no duplicate chat state machines per surface.

## Goals

- Show the user's sent message immediately on every chat surface.
- Show a pending assistant row immediately after the run is created, even before
  the first model token.
- Stream assistant deltas into the visible row as they arrive.
- Preserve streamed progress across transient SSE disconnects by reconnecting to
  the durable event log with `Last-Event-ID`.
- Recover from token minting failures, browser network interruptions, and early
  stream closure without requiring a page reload.
- Make new conversation first send stream in place without waiting for pane
  navigation to `/conversations/:id`.
- Use one shared frontend chat-run runtime for full-page chat and embedded
  reader chat.
- Keep all non-streaming browser requests on `/api/*` BFF routes.
- Keep streaming as direct browser to FastAPI `/stream/*` with short-lived stream
  tokens.
- Remove UX states where the composer clears and the transcript remains blank.
- Add tests that fail when a user must reload to see a completed assistant
  response.

## Non-Goals

- Do not replace durable chat runs with request-scoped streaming.
- Do not stream through the existing Next.js BFF proxy.
- Do not add a client polling fallback for assistant responses.
- Do not add feature flags or user-by-user rollout switches.
- Do not preserve a non-streaming chat path for assistant responses.
- Do not redesign the model catalog, prompt assembly, retrieval planner, or
  worker queue.
- Do not change the conversation, message, or chat-run schema unless a test
  proves the current durable event contract is insufficient.
- Do not make quote-to-chat open a full conversation pane automatically.
- Do not solve provider latency, retrieval latency, or model quality issues in
  this cutover except by making progress visible and recoverable.

## Final State

All chat surfaces use the same runtime contract:

1. `ChatComposer` submits `POST /api/chat-runs`.
2. The backend returns a durable run containing the user message and empty
   pending assistant message.
3. The visible transcript immediately merges those two messages.
4. The runtime opens direct SSE to FastAPI with a stream token.
5. `meta`, `tool_call`, `tool_result`, `citation`, `delta`, and `done` events
   update the same assistant row.
6. Temporary transport failure reconnects and replays from the last event id.
7. Terminal `done` reconciles the persisted run and marks the assistant message
   complete, error, or cancelled.
8. Reloading mid-run is optional recovery, not the primary way to see the
   answer.

New conversation panes are no longer empty route handoff screens after first
send. They render the same chat runtime as existing conversation panes. Once the
backend resolves or creates the conversation, the pane URL is replaced with
`/conversations/:id?run=:runId`, but visible streaming does not depend on that
navigation completing.

Embedded reader assistant panes and mobile quote sheets keep the reader-native
behavior from the quote-to-chat cutover: the assistant opens synchronously, sends
against the current scope, streams in place, and promotes to full chat only by
explicit user action.

## Target Behavior

### Existing Conversation

1. User types in `/conversations/:id`.
2. User sends.
3. Composer disables only for the active send request.
4. Transcript immediately appends the user message and an assistant pending row.
5. If retrieval or web search starts before the first model token, the assistant
   row shows tool activity.
6. First delta appears in the pending assistant row without reload.
7. On completion, the assistant row switches from streaming markdown to completed
   markdown plus persisted citations and evidence.
8. If the SSE connection drops, the assistant row remains visible and resumes
   from the durable event log.
9. If the run completes while the stream is reconnecting, the visible row is
   reconciled from `/api/chat-runs/:runId`.

### New Conversation

1. User opens `/conversations/new`.
2. User sends the first message.
3. The new conversation pane immediately shows the sent user message and pending
   assistant row.
4. The pane URL is replaced with `/conversations/:id?run=:runId` after the run
   exists.
5. Streaming continues through the URL replacement without a blank interstitial.
6. If the URL replacement unmounts the pane, the destination pane tails the same
   `run` from persisted events and replays any missed deltas.
7. The user never has to reload to see the first assistant response.

### Reader Assistant

1. Ask opens in the reader rail or mobile sheet before network work resolves.
2. Send starts a durable chat run with the pending contexts and selected scope.
3. The assistant streams in place in the reader surface.
4. Full chat promotion preserves `?run=:runId` while the run is active.
5. Closing and reopening the reader assistant preserves the active in-pane
   session while the media pane remains mounted.

### Reload And Resume

- Reloading `/conversations/:id?run=:runId` tails the run from persisted events.
- Reloading after a run is terminal renders the persisted user and assistant
  messages without opening a long-lived stream.
- Duplicate message rows are never shown after reload, reconnect, or URL
  replacement.
- Replayed deltas are not appended twice.

### Failure States

- A pending assistant row with no content shows an explicit generating state.
- A recoverable stream transport failure keeps the pending assistant row
  visible while reconnecting. It does not show a destructive error.
- A terminal model, context, quota, provider, or cancellation error is rendered
  from persisted run/message status.
- Stream token or configuration failures preserve transcript state and use the
  same recoverable retry and reconciliation path while the run remains active.
- Composer content is cleared only after the run has been created and visible
  messages have been merged.

## Architecture

### Request Topology

Preserve the repository topology:

```text
Normal HTTP:
Browser -> Next.js /api/* BFF -> FastAPI -> Postgres

Streaming:
Browser -> FastAPI /stream/* with stream token

Background generation:
Worker -> provider stream -> chat_run_events -> Postgres
```

Next.js BFF routes remain transport-only. They do not contain chat business
logic. The frontend calls FastAPI directly only for `/stream/*` endpoints after
minting a short-lived stream token through `/api/stream-token`.

### Backend Contract

Keep the current durable chat-run contract:

- `POST /chat-runs` validates input, creates or resolves the conversation,
  creates user and assistant messages, appends `meta`, enqueues a `chat_run`
  job, commits, and returns the run response.
- The worker owns provider calls and appends durable events.
- `/stream/chat-runs/{run_id}/events` owns replay and tail delivery only.
- Stream transport does not own provider generation lifecycle.
- Terminal run state is persisted before or with the terminal `done` event.

Required event order for one run:

1. `meta`
2. zero or more `tool_call`, `tool_result`, and `citation` events
3. zero or more `delta` events
4. exactly one `done` event

`done` is the only terminal SSE event. The stream route closes after emitting
`done` or after finding an already-terminal run with no remaining events.

### Frontend Runtime

Use the existing shared runtime hook for durable chat runs:

```text
useChatRunTail
  -> message merge
  -> active run registry
  -> stream token lifecycle
  -> SSE tail/replay
  -> run reconciliation
  -> scroll intent integration
```

This hook is the primary chat streaming runtime. Surface components own layout,
title, context panels, and promotion actions. They do not implement their own
streaming lifecycle.

Runtime responsibilities:

- Merge run response messages into local transcript exactly once.
- Track active runs by `run.id`.
- Track current user and assistant message ids after `meta`.
- Track last delivered event id per run.
- Fetch a fresh stream token per SSE connection attempt.
- Reconnect with `Last-Event-ID`.
- Reconcile from `/api/chat-runs/:runId` on terminal close, stream close without
  `done`, and recoverable stream errors.
- Restart the stream after recoverable errors while the run remains non-terminal.
- Stop only on terminal run state, explicit cancellation, unmount, or superseded
  run token.
- Dedupe replayed deltas using event ids and persisted assistant content length.
- Keep visible pending assistant state intact during connect, reconnect, and
  reconciliation.

### Component Structure

New or refactored frontend ownership:

- `apps/web/src/components/chat/useChatRunTail.ts`
  - Shared runtime hook.
  - Owns streaming and reconciliation.
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
  - Remains the low-level message mutation helper.
  - Handles delta buffering, tool events, citations, and terminal message status.
- `apps/web/src/components/chat/ChatSurface.tsx`
  - Pure transcript/composer layout.
  - Keeps transcript and composer layout separate from streaming runtime
    behavior.
- `apps/web/src/components/chat/MessageRow.tsx`
  - Shows pending assistant state when content is empty.
  - Shows tool activity and streaming markdown for pending content.
- `apps/web/src/components/ChatComposer.tsx`
  - Submits runs only.
  - Calls a single `onChatRunCreated` callback.
  - Does not navigate as its primary behavior.
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
  - Loads conversation metadata and history.
  - Installs shared runtime.
  - Tails `run` from URL and active runs from API.
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
  - Installs shared runtime with no initial conversation id.
  - Streams first send locally.
  - Replaces pane URL after conversation creation.
- `apps/web/src/components/chat/ReaderAssistantPane.tsx`
  - Uses shared runtime.
  - Owns reader-specific header, scope, context cards, and promotion.
- `apps/web/src/components/chat/QuoteChatSheet.tsx`
  - Mobile shell only.
  - Does not own chat-run streaming logic.
- `apps/web/src/lib/api/sse.ts`
  - Remains the direct FastAPI SSE client.
  - Exposes parsed event ids so the runtime can preserve `Last-Event-ID`
    across restarts.
- `apps/web/src/lib/api/streamToken.ts`
  - Remains the token client.
  - May gain retry/timeout primitives used by the runtime.

Backend files expected to stay structurally intact:

- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/tasks/chat_run.py`
- `python/nexus/auth/stream_token.py`
- `python/nexus/middleware/stream_cors.py`

Only change backend code if tests expose a contract violation.

## Key Decisions

### Direct SSE Stays

Do not add a Next.js `/api/.../events` stream endpoint. The repository already
defines streaming as direct browser to FastAPI. The current BFF proxy buffers
`text/*` responses and would defeat streaming unless given a special streaming
branch. This cutover avoids that path entirely.

### Reconnect Is Not A Polling Fallback

The client must reconnect to the event stream and replay durable events. It must
not poll `/api/chat-runs/:runId` until completion. Reconciliation is allowed at
connection boundaries to repair local state and determine whether a stream
should restart.

### Navigation Does Not Own Streaming

Pane URL replacement and workspace routing are secondary effects of run
creation. They must not be required for the first visible assistant response.

### One Runtime

Full conversations, new conversations, reader assistant, and mobile sheets must
share the same streaming runtime. Surface-specific forks are deleted.

### Pending Empty Assistant Is Visible

An empty pending assistant message is a valid state. Rendering `null` for that
state is a product bug after this cutover.

### Terminal State Comes From Persistence

The UI treats persisted run/message state as authoritative at terminal
boundaries. SSE deltas are incremental presentation, not a replacement for final
reconciliation.

## Rules

- Chat surfaces must not require reload to display a response that has been
  persisted.
- `ChatComposer` must not navigate by default after first send.
- New conversation first send must not depend on `router.replace` before
  showing messages.
- Client-side code must not call FastAPI directly except direct `/stream/*`
  requests with stream tokens.
- No BFF proxy route may be added for chat SSE.
- The runtime must fetch a fresh stream token per stream connection attempt.
- The runtime must send `Last-Event-ID` on reconnect when it has a delivered
  event id.
- The runtime must not append duplicate user messages, assistant messages,
  tool calls, citations, or deltas after replay.
- The runtime must stop reconnecting when the run is complete, error, cancelled,
  unmounted, or superseded.
- Recoverable stream errors must not clear transcript state.
- Terminal errors must be rendered from persisted assistant message status and
  error code.
- Empty pending assistant content must render an accessible status.
- Existing hard-cutover rules for quote-to-chat remain in force: reader Ask
  stays in the reader surface and full chat opens only by explicit promotion.
- No feature flags, compatibility branches, or legacy route-only code paths.

## Acceptance Criteria

### Product Acceptance

- Sending in an existing conversation shows the user message immediately.
- Sending in an existing conversation shows a visible pending assistant row
  immediately.
- Assistant text streams into the row token-by-token or chunk-by-chunk.
- Sending the first message from `/conversations/new` streams without reload.
- Mobile chat behavior matches desktop for visible pending row, streaming, and
  completion.
- Reader assistant sends stream in place on desktop and mobile.
- Reloading mid-run resumes from persisted events without duplicate text.
- Disconnecting and reconnecting the SSE request resumes without reload.
- A completed run that was missed during reconnect appears after reconciliation.
- A terminal failed run shows a clear terminal error row, not an endless pending
  row.

### Architecture Acceptance

- All chat surfaces use the shared durable runtime.
- No chat SSE is proxied through Next.js BFF.
- BFF route files remain thin proxies.
- Backend generation remains worker-owned.
- Stream route remains replay/tail only.
- No client polling loop exists for chat completion.
- No legacy new-chat route-only first-send flow remains.

### Test Coverage

- Component tests cover run response merge, visible empty pending assistant
  rows, existing history preservation, and streamed deltas entering the row.
- SSE unit tests cover event parsing, direct stream auth headers, fresh token
  minting on reconnect, `Last-Event-ID`, exposed delivered event ids, early
  close without `done`, and malformed event failure.
- Existing reader assistant, quote sheet, composer, and message row tests cover
  the surfaces that install or render the shared runtime.

## Implementation Notes

### 1. Harden Runtime

- Keep `useChatRunTail` as the shared chat streaming runtime.
- Keep `useChatMessageUpdates` as the low-level updater.
- Preserve current delta buffering through `requestAnimationFrame`.

### 2. Harden Stream Lifecycle

- Treat token mint failures as recoverable while the run is non-terminal.
- Treat network interruption and stream close without `done` as reconnectable.
- Reconcile before each restart to avoid duplicate content.
- Restart the stream when the reconciled run remains non-terminal.
- Stop when reconciliation returns a terminal run.
- Keep abort tokens so stale async continuations cannot mutate current state.

### 3. Refactor Existing Conversation Pane

- Replace direct `useChatRunTail` usage with shared runtime.
- Ensure sends merge messages before clearing composer content.
- Keep loading conversation metadata/history separate from active run tailing.
- Tail `run` query param and active runs through the same runtime entrypoint.

### 4. Refactor New Conversation Pane

- Replace static `messages={[]}` with shared runtime state.
- On first run creation, merge messages and start stream immediately.
- Replace the pane href after conversation creation while preserving `run`.
- Ensure URL replacement does not clear the active transcript.

### 5. Refactor Reader Assistant

- Use the same runtime for embedded reader chat.
- Keep reader-specific context, scope, telemetry, and promotion behavior.
- Ensure mobile sheet and desktop rail share the same runtime behavior.

### 6. Improve Pending UI

- Add accessible pending assistant text or indicator when content is empty.
- Keep tool activity visible above empty or streaming assistant content.
- Remove global pulsing of the whole message if it makes streamed text hard to
  read; use a small status affordance instead.

### 7. Verify Backend Contract

- Confirm every worker terminal path appends exactly one `done` event.
- Confirm stream route closes after `done`.
- Confirm stream route supports `Last-Event-ID` and `after` consistently.
- Confirm stream token CORS remains path-scoped and non-buffering.
- Change backend only if tests reveal missed terminal events or ownership gaps.

### 8. Tests

- Keep focused component coverage for the shared runtime behavior.
- Keep focused SSE tests for low-level stream client behavior.
- Add browser-level end-to-end coverage later if the repo gains an E2E harness.

## Key Details

### Run Merge

Merging a run response must replace any matching temporary or persisted ids and
sort by `seq`. The merge must be idempotent. Calling it repeatedly with the same
run response must leave one user message and one assistant message.

### Delta Replay

The runtime must track delivered SSE event ids. If a stream restarts without a
known event id, it must reconcile first and skip already-persisted assistant
content before appending replayed deltas. Duplicate prevention must be based on
durable event sequencing and persisted content, not timing.

### Reconciliation

Reconciliation loads `/api/chat-runs/:runId`, flushes buffered deltas, merges
persisted messages, updates active conversation id, and decides whether the run
is terminal. Reconciliation is a boundary repair step, not a polling loop.

### Stream Token Lifecycle

Stream tokens are one connection credential. The runtime supplies a fresh token
for every stream connection attempt. A failed token request uses the same
recoverable retry path as a failed stream connection while the run is
non-terminal.

### Backoff

Reconnect attempts use bounded exponential backoff with jitter. Backoff resets
after a successful event is received. The runtime never spins a tight retry loop.

### Cancellation

Cancelling a run posts `/api/chat-runs/:runId/cancel`, keeps the assistant row
visible, and lets persisted terminal state arrive through stream or
reconciliation. Aborting the browser stream is not cancellation.

### Scroll

Auto-scroll follows user intent. New outgoing messages force scroll to bottom.
Streaming deltas keep the transcript pinned only while the user remains near the
bottom. Loading older messages preserves scroll position.

### Accessibility

The transcript remains a named log region. Empty pending assistant content uses
an accessible status region. Streaming markdown must not cause focus loss.

## Risks

- Route replacement can unmount the new conversation pane and restart local
  state. The runtime must tolerate this by replaying from `run`.
- Stream CORS or `STREAM_BASE_URL` misconfiguration can still prevent direct
  browser streaming. The runtime must preserve transcript state while retrying
  and reconciling from persisted run state.
- Replaying deltas while also reconciling persisted assistant content can
  duplicate text if event-id and content-skip logic is loose.
- Multiple active runs in one conversation can interleave events. The runtime
  must key state by run id and assistant message id.
- Existing tests mock `fetch` at a high level and may miss direct FastAPI stream
  behavior unless runtime tests model the stream client explicitly.

## Workstream Split

1. Runtime extraction and recovery semantics.
2. Existing and new conversation pane integration.
3. Reader assistant/mobile sheet integration.
4. Pending UI polish.
5. Backend contract verification.
6. Unit and component coverage.

## Open Questions

- Should active full-chat sends support explicit user cancellation in the
  composer row during this cutover, or remain limited to backend cancellation
  APIs already present?
- Should the runtime expose telemetry events for token mint latency, first event
  latency, first delta latency, reconnect count, and terminal reconciliation?
- Should a conversation list row show active streaming state while a run is in
  progress, or is that outside this cutover?

These questions do not block the cutover. The no-reload, streamed response
behavior is required regardless of their answers.
