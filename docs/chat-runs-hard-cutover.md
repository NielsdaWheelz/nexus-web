# Durable Chat Runs

This is the hard-cutover implementation spec for replacing split chat send
paths with one durable chat-run lifecycle.

There is no legacy mode, compatibility adapter, fallback non-stream send path,
or duplicate stream orchestration after this work lands.

## Problem

Chat send is currently split between:

- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`

Those files share some helpers, but each owns meaningful business flow:
validation, context rendering, app search, web search, prompt construction,
provider execution, finalization, replay behavior, and token budget handling.

That makes stream and non-stream behavior drift-prone. It also lets an HTTP
stream connection own application work that should survive browser reloads,
network drops, and tab closes.

## Goals

- Make one durable chat run the only way to send a chat message.
- Make browser streaming a delivery mechanism, not the owner of LLM work.
- Persist user message, assistant placeholder, tool state, stream events, final
  assistant content, and LLM metadata through one canonical lifecycle.
- Let clients reconnect and resume missed events by cursor.
- Make idempotency mandatory for run creation.
- Keep control flow linear and explicit.
- Delete the old split send paths.
- Use the existing Postgres-backed worker system before considering external
  durable-execution infrastructure.

## Non-Goals

- No Temporal, Restate, Inngest, Cloudflare Workflows, or provider-hosted
  workflow engine in this cutover.
- No WebSocket transport.
- No provider-specific background-response API as the canonical architecture.
- No generic event bus, outbox framework, plugin system, adapter layer, or DSL.
- No reusable-looking orchestration abstraction unless it removes clear
  repeated complexity.
- No old `/stream/conversations/*/messages` send routes.
- No old JSON endpoint that performs provider execution in the request path.
- No automatic cancellation on browser disconnect.
- No claim of exactly-once distributed execution. The system uses durable state,
  idempotency, and duplicate-safe writes.

## Target Behavior

### Sending

1. The browser sends `POST /api/chat-runs` through the BFF.
2. The BFF proxies to FastAPI `POST /chat-runs`.
3. The request must include `Idempotency-Key`.
4. FastAPI validates the request, prepares messages, creates a `chat_runs` row,
   appends the first `chat_run_events` rows, enqueues one background job, and
   returns the run IDs.
5. The HTTP request does not call the LLM provider.
6. The browser opens `GET /stream/chat-runs/{run_id}/events`.
7. The stream route replays missed persisted events, then tails new events until
   a terminal event is observed.
8. If the target conversation already has a nonterminal run, creation fails with
   `E_CONVERSATION_BUSY`.

### Reconnect

1. Every SSE event includes an `id:` field with the event sequence.
2. The stream route accepts either `Last-Event-ID` or `?after=<seq>`.
3. On reconnect, the route returns events with `seq > after`.
4. If the run is terminal, the route sends the remaining events and closes.
5. If the run is active, the route sends remaining events and waits for more.

### Completion

1. The worker finalizes the assistant message and `message_llm`.
2. The worker appends one terminal event:
   - `done` with `status = "complete"`
   - `done` with `status = "error"`
   - `done` with `status = "cancelled"`
3. Conversation reads use the persisted `messages`, `message_tool_calls`,
   `message_retrievals`, and `message_llm` tables as the source of truth.
4. Stream events are progress and replay records. They do not replace the final
   message tables.
5. Assistant message finalization, `message_llm`, terminal run status, and the
   terminal `done` event commit in one DB transaction.

### Cancellation

1. Closing a tab, refreshing, or losing network does not cancel the run.
2. The user cancels with `POST /api/chat-runs/{run_id}/cancel`.
3. Cancellation sets `chat_runs.cancel_requested_at`.
4. The worker checks for cancellation before tools, before provider execution,
   and between provider chunks.
5. Cancelled runs finalize the assistant with `E_CANCELLED`.

## Architecture

```text
Browser
  |
  | POST /api/chat-runs
  v
Next.js BFF
  |
  | POST /chat-runs
  v
FastAPI route
  |
  | create conversation/messages/run/events/job
  v
Postgres
  |
  | background_jobs claim
  v
Worker
  |
  | tools + LLM provider + finalization
  v
Postgres

Browser
  |
  | GET /stream/chat-runs/{run_id}/events
  v
FastAPI stream route
  |
  | replay/tail chat_run_events
  v
Browser

On page load, the browser also reads active runs for the current conversation
with `GET /api/chat-runs?conversation_id=...&status=active` and tails each
returned run.
```

## Data Model

### `chat_runs`

One row per user send.

Columns:

- `id uuid primary key`
- `owner_user_id uuid not null`
- `conversation_id uuid not null`
- `user_message_id uuid not null`
- `assistant_message_id uuid not null`
- `idempotency_key text not null`
- `payload_hash text not null`
- `status text not null`
- `model_id uuid not null`
- `reasoning text not null`
- `key_mode text not null`
- `web_search jsonb not null`
- `next_event_seq integer not null default 1`
- `cancel_requested_at timestamptz`
- `started_at timestamptz`
- `completed_at timestamptz`
- `error_code text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Allowed statuses:

- `queued`
- `running`
- `complete`
- `error`
- `cancelled`

Indexes:

- Unique `(owner_user_id, idempotency_key)`
- Index `(owner_user_id, created_at, id)`
- Do not add a status index in the first migration. The background job table
  owns worker claiming.

Foreign keys:

- Reference `users`, `conversations`, and `messages`.
- Cascade on delete so deleting a conversation or message removes its run rows
  and replay events.

### `chat_run_events`

Append-only replay log for user-visible run progress.

Columns:

- `id uuid primary key`
- `run_id uuid not null`
- `seq integer not null`
- `event_type text not null`
- `payload jsonb not null`
- `created_at timestamptz not null default now()`

Constraints:

- Unique `(run_id, seq)`

Indexes:

- `(run_id, seq)`

Sequence rule:

- The service reads `chat_runs.next_event_seq`.
- The service inserts the event with that `seq`.
- The service increments `chat_runs.next_event_seq`.
- The insert happens in the same transaction as the state change it reports.
- Do not use `INSERT ... ON CONFLICT`.

## Events

Use a small fixed event set.

- `meta`
- `tool_call`
- `tool_result`
- `citation`
- `delta`
- `done`

Rules:

- `meta` is first.
- `done` is terminal.
- No event follows `done`.
- `delta.payload.delta` is a text append.
- Delta events may batch provider chunks. They do not preserve provider chunk
  boundaries.
- Tool and citation payloads reuse the persisted product fields already exposed
  by conversation message reads.
- Do not add event versions or wrappers in this cutover.

SSE formatting:

```text
id: <seq>
event: <event_type>
data: <payload json>

```

Keepalive:

- While waiting for new events, send an SSE comment every 15 seconds.
- Keepalive comments are not stored in `chat_run_events`.

## Runtime Flow

### Create Run

`POST /chat-runs` performs this linear flow:

1. Require authenticated viewer.
2. Require `Idempotency-Key`.
3. Validate request body.
4. Compute payload hash from content, model, reasoning, key mode, contexts,
   web search, and conversation ID.
5. Select existing `chat_runs` row for `(viewer_id, idempotency_key)`.
6. If found with same payload hash, return it.
7. If found with different payload hash, return
   `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`.
8. Run pre-validation with no writes.
9. Open one DB transaction.
10. Create or load the conversation.
11. Insert the user message.
12. Insert message contexts.
13. Insert the assistant placeholder.
14. Insert `chat_runs`.
15. Insert `meta` event.
16. Enqueue one `background_jobs` row with kind `chat_run`.
17. Commit.
18. Return run and message IDs.

No provider call, web search call, app search call, or other non-DB side effect
runs inside the transaction.

### Execute Run

The `chat_run` background job performs this linear flow:

1. Load the run.
2. If status is terminal, return success.
3. If `cancel_requested_at` is set, finalize cancelled.
4. Mark status `running` and set `started_at` if not already set.
5. Resolve the model and API key.
6. Reserve platform budget when using a platform key.
7. Render attached context.
8. If quote context blocks, finalize error and append `done`.
9. Run app search if needed.
10. Persist app-search tool rows.
11. Append app-search events.
12. Check cancellation.
13. Run web search if needed.
14. Persist web-search tool rows.
15. Append web-search events and citation events.
16. Check cancellation.
17. Load prompt history.
18. Render the prompt.
19. Start provider streaming.
20. Append batched `delta` events while chunks arrive.
21. Check cancellation between chunks.
22. Finalize the assistant message and `message_llm`.
23. Commit or release token budget.
24. Mark run terminal.
25. Append terminal `done`.

Provider interruption rule:

- If the worker process dies before any provider bytes are persisted, the job may
  retry the provider call.
- If a `delta` event exists and there is no terminal event, the retry finalizes
  the run with `E_LLM_INTERRUPTED`.
- Do not start a second provider call after partial provider output was already
  persisted.

This avoids duplicate LLM side effects and avoids mixing two different sampled
answers into one assistant message.

### Stream Events

`GET /stream/chat-runs/{run_id}/events` performs this linear flow:

1. Verify the stream token.
2. Verify the viewer owns the run.
3. Read `after` from query or `Last-Event-ID`.
4. Select events where `seq > after`, ordered by `seq`.
5. Yield each event.
6. If a yielded event is terminal, close.
7. If no terminal event has been seen, wait briefly and repeat.
8. Send keepalive comments while waiting.

The stream route never calls tools, never calls the LLM provider, and never
finalizes messages.

## API

### FastAPI

New:

- `POST /chat-runs`
- `GET /chat-runs?conversation_id=...&status=active`
- `GET /chat-runs/{run_id}`
- `POST /chat-runs/{run_id}/cancel`
- `GET /stream/chat-runs/{run_id}/events`

Create request:

- `conversation_id` optional
- `content`
- `model_id`
- `reasoning`
- `key_mode`
- `contexts`
- `web_search`

Create response:

- `run.id`
- `run.status`
- `conversation`
- `user_message`
- `assistant_message`

Read response:

- The same shape as create, with current persisted state.

List response:

- `data[]` entries use the same shape as create.
- `status=active` means queued or running, not complete/error/cancelled.

Removed:

- `POST /conversations/messages`
- `POST /conversations/{conversation_id}/messages`
- `POST /stream/conversations/messages`
- `POST /stream/conversations/{conversation_id}/messages`

### BFF

New:

- `POST /api/chat-runs`
- `GET /api/chat-runs?conversation_id=...&status=active`
- `GET /api/chat-runs/{run_id}`
- `POST /api/chat-runs/{run_id}/cancel`

The stream remains direct browser to FastAPI through `/stream/*` with stream
token auth.

## Backend Structure

New files:

- `python/nexus/api/routes/chat_runs.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/tasks/chat_run.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_chat_run_stream.py`

Changed files:

- `python/nexus/api/routes/__init__.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/jobs/registry.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/web_search.py`
- `python/nexus/services/rate_limit.py` only if budget reservation helpers need
  a small chat-run-specific call site change.
- `python/nexus/tasks/__init__.py`

Deleted files:

- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/services/stream_liveness.py`
- `python/nexus/tasks/sweep_pending.py`

Deletion rule:

- Do not leave forwarding modules, compatibility imports, or route aliases.

## Frontend Structure

New files:

- `apps/web/src/app/api/chat-runs/route.ts`
- `apps/web/src/app/api/chat-runs/[runId]/route.ts`
- `apps/web/src/app/api/chat-runs/[runId]/cancel/route.ts`

Changed files:

- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/lib/conversations/types.ts`
- Chat message components that render active tool state.
- E2E tests that send chat messages.

Deleted behavior:

- Non-streaming fallback send in `ChatComposer`.
- Client parsing for old `/stream/conversations/*/messages` send responses.
- Poll-for-completion behavior based on `E_STREAM_IN_PROGRESS`.

## Key Decisions

### Use Postgres and Existing Worker Jobs

The repo already has Postgres, migrations, `background_jobs`, and worker lease
logic. This cutover uses those first.

### Make Idempotency Required

Run creation mutates conversation state and enqueues background work. Mandatory
idempotency makes client retries safe and removes optional branching.

### Use Persisted Events for Resume

SSE reconnection uses stored `chat_run_events`. There is no in-memory stream
state and no stream liveness marker.

The browser sends `Last-Event-ID` and mints a fresh stream token for each
connection attempt.

### Keep Provider Execution Out Of HTTP

HTTP routes create, cancel, read, or tail runs. Only the worker calls tools and
LLM providers.

### Do Not Retry Partial Provider Streams

Provider streams are not resumable in the provider-neutral contract. Retrying
after partial deltas can duplicate cost and corrupt the final assistant message.
Partial-provider crash therefore finalizes a controlled error.

### Keep Event Shapes Small

The stream event set is fixed and product-facing. Do not introduce event
versions, manifests, nested envelopes, or generic event wrappers in this cutover.

### Keep Tool Helpers Concrete

`execute_app_search` and `execute_web_search` may stay as concrete helpers
because they encapsulate real search and persistence complexity. Do not add a
generic tool orchestrator for this cutover.

## Code Rules

- Routes contain transport logic only.
- Services contain business logic and no HTTP framework types.
- The stream route only formats and tails SSE.
- No non-DB side effect runs inside a DB transaction.
- Use explicit SELECT, then INSERT, UPDATE, or DELETE.
- Do not use `INSERT ... ON CONFLICT` in new chat-run code.
- Do not use `rowcount` for normal control flow.
- Tool persistence touched by this cutover follows the same explicit
  SELECT-then-mutate rule.
- Branch explicitly on known statuses and error types.
- Any top-level worker defect guard must log the real exception and finalize
  with a controlled internal error only when the run has not already finalized.
- Keep the implementation linear. Prefer one readable function over several
  one-use helpers.
- Do not add generic protocols, adapters, builders, event sinks, or reusable
  registries for chat runs.
- Extract a function only when it removes repeated complexity or isolates a
  risky operation with a clear name.
- Constants are allowed only for values reused across code or values with clear
  product meaning, such as keepalive interval and event type names.

## Testing Plan

Write failing tests from the acceptance criteria first.

Backend integration tests:

- Create run for a new conversation.
- Create run for an existing conversation.
- Idempotency replay returns the same run.
- Idempotency mismatch returns
  `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`.
- Missing `Idempotency-Key` fails.
- Conversation busy fails when a nonterminal run already exists.
- Worker completes a plain chat run.
- Worker persists app-search tool rows and events.
- Worker persists web-search tool rows, retrieval rows, citation events, and
  final answer.
- Quote-context blocking finalizes assistant error and terminal event.
- Explicit cancel finalizes `E_CANCELLED`.
- Worker retry after completed run is a no-op.
- Worker retry after partial deltas finalizes `E_LLM_INTERRUPTED` and does not
  call the provider again.

Streaming integration tests:

- Event stream starts from the first event without `after`.
- Event stream resumes from `after`.
- Event stream honors `Last-Event-ID`.
- Event stream closes after terminal event.
- Browser disconnect does not change run status.
- Reconnect after disconnect receives missed events.

Frontend and E2E:

- Composer creates a run, tails events, renders deltas, and shows final message.
- Refresh during generation resumes the same run.
- Multiple tabs can tail the same run.
- Cancel button calls cancel endpoint and renders cancelled state.
- There is no non-streaming fallback path in the UI.

## Acceptance Criteria

### Cutover

- Old send-message routes are removed.
- Old stream send routes are removed.
- `send_message.py`, `send_message_stream.py`, `stream_liveness.py`, and
  `sweep_pending.py` are deleted.
- No compatibility forwarding imports remain.
- The frontend sends chat messages only through `POST /api/chat-runs`.

### Durability

- A chat run survives browser disconnect.
- A chat run survives page refresh.
- A reconnect resumes from the last received event.
- Completed tool calls are not duplicated by idempotency replay or worker retry.
- A completed run is never executed again.
- A run has exactly one terminal status.
- A run has exactly one terminal `done` event.
- The assistant message and `message_llm` finalize once.

### Product Behavior

- Chat shows tool activity while app search or web search runs.
- Chat shows citation events before or with the final answer when web results
  are selected.
- Final conversation reads show the completed assistant content and persisted
  tool calls.
- Browser disconnect does not create `E_CLIENT_DISCONNECT`.
- Explicit cancel creates `E_CANCELLED`.

### Safety

- Provider API keys never reach stream events, persisted event payloads, prompts,
  or browser responses.
- Web and app search provider raw payloads do not become stream payloads.
- Retrying a partial provider stream does not start a second provider call.
- Token budget is reserved before provider execution and committed or released
  after finalization.

### Simplicity

- There is one chat-run service module.
- There is one worker task for chat runs.
- There is one stream tail route.
- There is no generic orchestration framework in the app code.
- There are no one-use adapters, builders, wrappers, or event sink interfaces.

## Rollout

This is a hard cutover.

1. Add migrations.
2. Add failing tests.
3. Add the new chat-run route, service, task, and stream tail.
4. Update the frontend to use chat runs.
5. Remove old routes and files.
6. Remove old tests that assert split send behavior.
7. Run backend, frontend, and E2E gates.

No feature flag preserves the old send path.
