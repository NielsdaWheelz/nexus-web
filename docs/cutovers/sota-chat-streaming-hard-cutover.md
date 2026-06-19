# SOTA Chat Streaming Hard Cutover

Status: SPEC - Rev 1
Author altitude: SME / staff
Date: 2026-06-18
Type: hard cutover - no legacy paths, no fallbacks, no backward compatibility,
no compatibility shims, no dual stream contracts.

Supersedes the chat/provider-streaming assumptions in:

- `docs/cutovers/generation-run-harness-hard-cutover.md` sections that treat
  `ModelChunk`, chat SSE `delta`, or char-count replay skipping as sufficient
  long-term contracts.
- `docs/cutovers/llm-provider-runtime-hard-cutover.md` where it documents the
  current `ModelRuntime.stream()` chunk shape as final rather than as the
  current implementation state.

Does not supersede:

- the durable generation harness;
- `provider_runtime` as the only provider wire-protocol owner;
- `run_kit` as the durable event/terminal owner;
- `/stream/*` as the browser-to-FastAPI SSE exception;
- `llm_ledger` as the provider-call flight recorder;
- chat branching, prompt assembly, citations, search tools, or resource-subject
  chat ownership.

---

## 0. North Star

Every chat in Nexus streams like a modern agent product: immediate local send,
clear pre-token activity, smooth text arrival, visible tool intent as soon as
the provider exposes it, prompt cancellation that actually aborts work, durable
reconnect without duplicate or missing text, complete terminal usage/error
recording, and reload parity.

The architecture remains strict:

```text
Provider SSE / HTTP stream
  -> provider_runtime typed stream events
  -> Nexus chat run execution and durable event log
  -> /stream/chat-runs/{id}/events cursor tail
  -> frontend fold/reconcile state
  -> ChatSurface render and scroll behavior
```

Transport is still a dumb pipe. Provider semantics still live in
`../llm-calling`. Nexus still owns durable app state. The frontend still renders
from typed domain events and reconciles against persisted truth.

The cutover upgrades the weakest layer boundaries instead of papering over them:

- `provider_runtime` stops exposing a coarse `ModelChunk` as the public stream
  protocol.
- Nexus stops treating provider text as a per-token DB commit stream.
- Chat replay stops depending on assistant-text length heuristics.
- Cancellation stops being only a local SSE detach or a flag checked after the
  provider eventually yields.
- Tests stop proving only generic SSE plumbing and start proving live chat UX.

---

## 1. SME Thesis

The product already has the right skeleton: durable `ChatRun`, worker-owned
execution, persisted events, `/stream/*` tokens, `Last-Event-ID`, `run_kit`,
`llm_ledger`, and a shared frontend stream opener. The professional move is not
to swap SSE for WebSockets or import a chat framework wholesale.

The professional move is to make each boundary carry the information it owns:

- provider-runtime emits a typed, provider-faithful stream event union;
- Nexus translates those events into a compact durable chat event grammar;
- `GET /chat-runs/{id}` can materialize a pending run from persisted events and
  return a cursor, so SSE resume starts after known state;
- the frontend folds by event sequence, not by text length;
- cancellation and timeout policy are explicit capability contracts;
- observability measures first-token and streaming quality, not just final
  success;
- tests exercise provider tool streaming, reconnect, cancel, and long-message
  rendering as first-class behavior.

The one-user prototype constraint changes scale choices, not correctness
choices. We can use Postgres event rows and SSE rather than a stream broker, but
the contracts remain the contracts a larger system would keep.

---

## 2. Current Head Facts

### 2.1 Existing good architecture to keep

- Browser product data normally goes through the same-origin BFF. The explicit
  exception is browser-to-FastAPI `/stream/*` with a short-lived single-use
  stream token minted through `/api/stream-token`.
- FastAPI stream routes authenticate the stream token, assert ownership, and
  tail persisted rows. `LISTEN/NOTIFY` is a wake-up; committed rows are truth.
- `useGenerationRun` / `openGenerationRunStream` already centralizes stream
  token minting plus path building for generation streams.
- `sseClientDirect` already owns fetch streaming, fresh token per reconnect,
  `Last-Event-ID`, reconnect backoff, content-type checks, abort, and JSON SSE
  parsing.
- `useChatRunTail` is the chat multi-run orchestration layer over the generic
  stream client; `useChatMessageUpdates` RAF-batches text deltas into message
  state.
- `provider_runtime` already captures opaque provider artifacts and enforces
  retry-before-first-visible-stream-output.

### 2.2 Current gaps this spec owns

- `provider_runtime.ModelChunk` is too coarse. It lacks a stable event type
  enum, provider event identity, item/content/tool indices, partial tool-call
  deltas, timestamps, structured terminal cancel/fail events, and enough
  metadata to build SOTA UI without provider leakage.
- Tool calls are exposed only when arguments are complete and parseable. Modern
  provider streams expose tool-call starts and partial inputs; SOTA UI can show
  safe intent/progress before the tool executes.
- Nexus persists each non-empty provider text chunk with a DB commit. This is
  robust, but it can be unnecessarily write-heavy and jittery for long streams.
- `useChatRunTail` replay suppression depends on persisted assistant text
  length after reconcile. This is a pragmatic heuristic, not a durable cursor
  contract.
- Backend cancellation is checked while provider chunks arrive. A quiet provider
  read can delay cancellation until the next chunk or timeout.
- The UI has limited first-token/reconnect/activity state. Users see a pending
  row and tool events once they occur, but not a complete live state machine.
- Direct tests for chat-specific tailing, replay suppression, visible cancel,
  real DB/HTTP streaming after open, browser reconnect, and live streaming tool
  calls are missing or indirect.

### 2.3 External SOTA signals

The current major providers and AI UI libraries have converged on evented,
multi-part streams:

- OpenAI Responses models output items such as messages, function calls, and
  reasoning items.
- Anthropic Messages streams content-block lifecycle events, partial tool JSON,
  thinking deltas, and signatures.
- Gemini streams step events and thought signatures for stateless manual
  continuation.
- AI SDK UI distinguishes plain text streams from data streams and treats tool
  call streaming as a first-class UI state.

Nexus does not copy any one vendor's wire protocol. It normalizes the
cross-provider ideas that matter: event kind, sequence, item identity, partial
text, partial tool input, terminal status, usage, request id, opaque replay
artifacts, and safe activity state.

---

## 3. Hard-Cutover Posture

- No public `ModelChunk` streaming contract after the cutover. If a private
  adapter helper keeps the name during implementation, it must not be exported.
- No old chat SSE event parser fallback. The frontend validates only the new
  event grammar.
- No dual event names such as `delta` plus `assistant_text_delta`.
- No frontend char-count replay skip.
- No provider-specific branching in Nexus chat execution beyond reading the
  provider-neutral stream event union.
- No transport-driven execution path. The worker still owns the run; the stream
  only tails rows.
- No hidden provider reasoning, prompt, API key, raw request body, or raw
  provider stream data in product UI, logs, or persisted chat events.
- No WebSocket parallel path.
- No automatic cross-provider/model fallback after a stream starts.
- No retry after a visible text delta, tool event, or opaque provider artifact
  escapes `provider_runtime`.
- No structured-output streaming for chat unless the provider-runtime
  capability contract and tests make it explicit.
- No compatibility migrations that preserve old event rows as first-class data.
  If local/dev rows exist, the migration can delete or normalize them as a
  one-time hard cutover.

Keeping a good current name is allowed only when it remains the single current
contract. Keeping an old name as a second accepted payload shape is not allowed.

---

## 4. Goals

G1. Provider-faithful stream protocol. `provider_runtime` exposes one typed
stream event union with explicit text, tool, artifact, usage, terminal, retry,
timeout, and cancellation semantics.

G2. Smooth durable chat text. Nexus coalesces provider text into bounded,
low-latency durable events instead of committing every provider chunk.

G3. Cursor-based replay. Chat reconcile returns a materialized pending message
plus an event cursor. SSE resumes after that cursor. No text-length replay skip.

G4. Real cancellation. A user stop action calls the backend cancel route and the
worker races provider reads against cancellation, then closes the provider
stream and emits a normalized terminal event.

G5. Rich safe activity. Chat can show safe live states such as queued,
reasoning, writing, calling tool, searching, reading, reconnecting, cancelling,
cancelled, failed, and complete without exposing hidden reasoning content.

G6. One frontend stream fold. Full chat, resource chat, reader/media quote chat,
and library-intelligence subject chat all flow through `useConversation`,
`useChatRunTail`, and `useChatMessageUpdates`.

G7. Observable streaming quality. Operator state includes time-to-first-provider
event, time-to-first-visible-text, provider event count, durable flush count,
SSE reconnect count, cancel latency, terminal cause, and provider request ids.

G8. Production-grade proof. Tests cover provider stream adapters, Nexus durable
mapping, DB/HTTP streaming after connection open, frontend reconnect/cancel,
long-message rendering, and live provider streaming tool calls.

---

## 5. Non-Goals

N1. No WebSockets, WebRTC, Realtime API, or bidirectional voice/audio transport
for text chat. SSE remains correct for durable text/event delivery.

N2. No provider-managed conversation state as the default. Nexus remains
stateless at the provider boundary and replays its own conversation/tool state.

N3. No streaming hidden reasoning content. Provider artifacts may be captured
and replayed, but never displayed or logged with content.

N4. No generic stream broker. Postgres event rows plus LISTEN/NOTIFY are enough
for the prototype and already match repo doctrine.

N5. No token-perfect UI guarantee. The UI promises smooth text and exact final
content, not one DOM update per provider token.

N6. No rewrite of chat branching, search, citations, trust trail, resource
subjects, or prompt assembly except where the streaming contract directly
touches them.

N7. No token streaming for oracle or library-intelligence synthesis. They keep
their structured generation contracts and share only the generic stream client
and terminal grammar where applicable.

N8. No usage/cost dashboard. New metrics are persisted/logged for operators and
tests, not surfaced as product UI.

---

## 6. Scope

In scope:

- `../llm-calling` / `provider_runtime` public stream API, adapters, catalog
  stream capabilities, fake runtime, unit/golden/live tests.
- Nexus chat run execution, event schemas, DB event grammar, coalescing,
  cancellation, response materialization, telemetry, tests, and migrations.
- Nexus frontend chat stream parsing/folding, status state, stop action, scroll
  and markdown rendering behavior, and tests.
- Docs and negative gates that pin the new contract.

Out of scope:

- Provider-runtime non-chat `generate`, `embed`, and `transcribe` contracts
  except where shared types or catalog capabilities must be renamed.
- Oracle/LI/media stream UI changes beyond ensuring no duplicate generic stream
  client emerges.
- Android shell changes.
- Deployment/publish work.

Definition of "all chats":

- full conversation panes;
- resource-subject chats through `ResourceChatDetail`;
- reader/media quote-to-chat surfaces that use the shared chat composer path;
- library intelligence revision/resource chats that open `ResourceChatDetail`;
- any future chat adapter using `useConversation` and `/api/chat-runs`.

---

## 7. Final Architecture

### 7.1 Provider-runtime stream protocol

`ModelRuntime.stream(call, *, key, timeout_s, cancel=None)` returns:

```python
AsyncIterator[ModelStreamEvent]
```

`ModelStreamEvent` is a strict tagged union. Common fields:

```python
type: Literal[
    "stream_start",
    "activity",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_done",
    "provider_artifact",
    "usage_delta",
    "completed",
    "incomplete",
    "failed",
    "cancelled",
]
sequence: int
provider: ProviderName
model: str
route: str | None
provider_event_type: str | None
provider_event_id: str | None
provider_request_id: str | None
item_id: str | None
item_index: int | None
content_index: int | None
tool_call_id: str | None
tool_call_index: int | None
created_at_ms: int
retry_attempt: int
raw_metadata: Mapping[str, JsonValue]
```

Event-specific payloads:

- `stream_start`: provider request accepted/started, when observable.
- `activity`: safe non-secret phase only:
  `queued | thinking | writing | tool_calling | waiting | retrying`.
- `text_delta`: visible text only, non-empty.
- `tool_call_start`: tool name/call identity known, arguments may be empty.
- `tool_call_delta`: partial JSON argument text and optional partial parsed
  object when safe; never executed.
- `tool_call_done`: complete parsed `ToolCall`; malformed arguments produce
  `failed` with `TOOL_ARGUMENTS_INVALID`.
- `provider_artifact`: opaque `ProviderArtifact` only; not stringify-safe.
- `usage_delta`: optional provider usage progress if a provider exposes it.
- `completed`: terminal success with final usage, status, request id, attempts.
- `incomplete`: terminal provider incomplete state with usage and details.
- `failed`: terminal typed `ModelCallError` data.
- `cancelled`: terminal cancellation metadata.

Terminal invariants:

- Exactly one terminal event: `completed`, `incomplete`, `failed`, or
  `cancelled`.
- Usage/status/incomplete details are terminal unless emitted as explicit
  `usage_delta`.
- `provider_artifact` may appear before any visible text and still counts as
  "stream output escaped" for retry safety.
- After any `text_delta`, `tool_call_*`, or `provider_artifact` event escapes,
  provider-runtime must not retry the provider request.
- Event `sequence` is provider-runtime local and monotonic per call. Nexus maps
  it into durable `chat_run_events.seq`; it never persists provider sequence as
  the stream cursor.

`ModelChunk` is deleted from the exported API. `ModelResponse` remains for
non-streamed calls.

### 7.2 Provider-runtime adapter architecture

Adapters parse provider wire events into low-level provider-native records.
A shared stream assembler owns the cross-provider mechanics:

- monotonic event sequences;
- terminal enforcement;
- retry-attempt attachment;
- provider request id propagation;
- tool-call argument accumulation;
- parsed-tool validation;
- provider-artifact validation;
- terminal usage/status mapping;
- visible-output retry cutoff;
- cancellation and timeout classification.

Provider adapters remain responsible only for provider-specific parsing and
request-body construction:

- OpenAI Responses: output item lifecycle, function-call argument deltas,
  reasoning encrypted content as opaque artifacts, terminal completed/incomplete
  events, request id, usage.
- Anthropic Messages: message/content-block lifecycle, input JSON deltas,
  thinking/signature artifacts, message delta/stop usage.
- Gemini: generateContent or Interactions stream mapping, function-call ids,
  thought signatures, thought text stripping, terminal finish reason and usage.
- OpenAI-compatible routes: chat-completions deltas, tool-call accumulation,
  provider-specific usage/request-id where available.

### 7.3 Provider capability contract

`provider_runtime.catalog.ModelCapabilities` gains a nested `stream` contract:

```python
@dataclass(frozen=True)
class StreamCapabilities:
    supported: bool
    text_deltas: bool
    activity_events: bool
    tool_call_start: bool
    tool_call_delta: bool
    tool_call_done: bool
    provider_artifacts: bool
    usage_delta: bool
    terminal_usage: bool
    native_event_ids: bool
    provider_request_id: bool
    structured_output_streaming: bool
    cancellation: Literal["http_close", "best_effort", "none"]
    default_connect_timeout_s: float
    default_read_idle_timeout_s: float
    default_total_timeout_s: float
    max_total_timeout_s: float
```

Nexus reads only the UI-safe projection it needs: streaming supported, tool
streaming supported, activity supported, cancellation supported, and timeout
policy. Internal provider details stay backend-owned.

### 7.4 Nexus durable chat event grammar

Chat event types after the cutover:

```text
meta
assistant_activity
assistant_text_delta
tool_call_start
tool_call_delta
tool_call_done
tool_result
citation_index
context_ref_added
done
```

Old `delta`, `tool_call`, and `retrieval_result` are deleted. They are not
accepted by backend validation, frontend parsers, or DB CHECK constraints.

Payload principles:

- Every event includes `assistant_message_id` when it applies to assistant
  output.
- Every provider-derived event includes `provider_event_seq_start` and
  `provider_event_seq_end`.
- Every durable event has DB `seq`; that DB `seq` is the only replay cursor.
- `assistant_text_delta.text` is non-empty visible text. It may coalesce many
  provider `text_delta` events.
- Tool-call delta events are safe to render as partial input, but never execute
  tools. Execution starts only after `tool_call_done`.
- `tool_result` is the shared result event for app search, web search,
  read-resource, inspect-resource, and future tools. Retrieval-bearing results
  carry trust-trail/retrieval payloads; non-retrieval results carry safe status.
- `done` is the sole terminal event and carries:
  `{status, error_code, final_chars, last_provider_event_seq, usage?, cancelled?}`.

### 7.5 Backend coalescing

Provider text events pass through a bounded coalescer before durable append:

```python
CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
```

Flush triggers:

- interval elapsed;
- char/byte cap reached;
- provider activity changes away from writing;
- tool event arrives;
- provider artifact arrives;
- cancellation requested;
- stream terminal event arrives;
- local max assistant length approaches;
- exception path before finalization.

The coalescer is local to `execute_chat_run`. It does not own transport and it
does not buffer terminal events. It reduces write volume while preserving a
sub-frame UI cadence once the frontend RAF-batches.

### 7.6 Cursor-based materialization and replay

`GET /chat-runs/{id}` returns a server-materialized run snapshot:

```json
{
  "run": { "...": "existing fields" },
  "messages": [],
  "stream_state": {
    "status": "queued|running|complete|failed|cancelled|interrupted",
    "last_event_seq": 42,
    "folded_event_seq": 42,
    "assistant_current_text": "...",
    "reconnectable": true,
    "terminal": false
  }
}
```

Rules:

- For pending/running runs, the backend folds persisted chat events to build the
  current assistant text and trust/activity state. The response includes the
  last DB event sequence folded into that snapshot.
- The frontend opens SSE with `after=folded_event_seq`.
- `Last-Event-ID` remains the reconnect cursor inside a stream connection.
- Reconcile on reconnect replaces local state with the server snapshot and then
  resumes after the server cursor.
- No text-length skip exists.

This is the key replay cutover. The source of truth is event sequence, not the
number of rendered characters.

### 7.7 Cancellation

Frontend stop action:

- calls `POST /api/chat-runs/{runId}/cancel`;
- sets local status to `cancelling`;
- keeps the SSE open until `done {status:"cancelled"}` or a reconciled terminal
  cancelled state arrives;
- local `AbortController` detaches only when leaving the view or after terminal.

Backend execution:

- cancel route sets `chat_runs.cancel_requested_at`;
- worker races provider stream reads against a cancellation watcher;
- cancellation watcher is push-first. Bounded polling is permitted only when it
  is documented with `justify-polling` and named timing constants;
- when cancel wins, worker closes the provider stream, records abandoned or
  cancelled in `llm_ledger`, flushes any text coalescer buffer, finalizes the
  run with `E_CANCELLED`, and appends terminal `done`.

Provider-runtime:

- accepts a cancellation signal;
- closes the underlying HTTP stream where possible;
- emits terminal `cancelled` if cancellation occurs inside the runtime after
  the request started;
- exposes cancellation capability in the catalog.

### 7.8 Timeout policy

Chat does not use one hard-coded timeout for every model. Timeout policy is:

- connect timeout;
- read-idle timeout;
- total timeout;
- provider-runtime retry deadline;
- Nexus job lease.

Provider-runtime catalog supplies model/route defaults and max values. Nexus
chat picks a per-call policy from model capability and operation type. Long
reasoning models can have a larger total timeout without hiding a dead stream.

Terminal mapping:

- no bytes before visible output: runtime may retry if policy allows;
- timeout after visible output: no retry; Nexus finalizes interrupted/failed
  with partial output preserved and retry affordance;
- Nexus job lease expiry: worker dead-letter/finalizer owns the terminal state.

### 7.9 Frontend stream state

`useChatRunTail` exposes per-run state to `useConversation`:

```ts
type ChatRunLiveState =
  | { phase: "queued" }
  | { phase: "connecting" }
  | { phase: "reconnecting"; attempt: number }
  | { phase: "thinking" }
  | { phase: "writing"; firstTextAt: number | null }
  | { phase: "tool_calling"; toolName: string; partialInput?: unknown }
  | { phase: "running_tool"; toolName: string }
  | { phase: "cancelling" }
  | { phase: "cancelled" }
  | { phase: "failed"; errorCode: string }
  | { phase: "complete" };
```

`AssistantMessage` renders this state through restrained controls:

- stop button while queued/running/reconnecting/cancelling is meaningful;
- safe activity text or existing gutter cue before first text;
- reconnect indicator only when it materially affects the run;
- partial tool input only if provider/runtime marks it safe and parsed enough;
- no hidden reasoning content.

### 7.10 Frontend text folding and rendering

`useChatMessageUpdates` remains the fold layer, but it folds by event sequence:

- keep `lastFoldedEventSeq` per run;
- reject duplicate/older durable events;
- buffer `assistant_text_delta` by message id until `requestAnimationFrame`;
- flush before any non-text event that must appear in order;
- flush before `done`.

`MarkdownMessage` remains the render owner for markdown. Target behavior:

- completed message blocks are memoized;
- only the streaming tail reparses while text is arriving;
- long conversations do not remount earlier message rows every frame;
- scroll anchoring continues to be owned by `ChatSurface` / `useChatScroll`.

---

## 8. API Design

### 8.1 Provider-runtime public API

```python
async for event in runtime.stream(
    call,
    key=provider_key,
    timeout_s=timeout.total_s,
    cancel=cancel_signal,
):
    match event.type:
        case "text_delta":
            ...
        case "tool_call_delta":
            ...
        case "completed":
            ...
```

Public exports:

- `ModelStreamEvent`
- `ModelStreamStart`
- `ModelStreamActivity`
- `ModelTextDelta`
- `ModelToolCallStart`
- `ModelToolCallDelta`
- `ModelToolCallDone`
- `ModelProviderArtifactEvent`
- `ModelUsageDelta`
- `ModelStreamCompleted`
- `ModelStreamIncomplete`
- `ModelStreamFailed`
- `ModelStreamCancelled`
- `StreamCapabilities`
- `CancelSignal` / protocol type if needed

Removed public export:

- `ModelChunk`

### 8.2 Nexus backend API

FastAPI stream route remains:

```http
GET /stream/chat-runs/{run_id}/events?after=<seq>
Authorization: Bearer <stream-token>
Last-Event-ID: <seq>
```

The route still returns SSE:

```text
id: <chat_run_events.seq>
event: assistant_text_delta
data: {"assistant_message_id":"...", "text":"...", ...}
```

`GET /chat-runs/{id}` gains `stream_state` and returns pending assistant state
materialized from the event log.

`POST /chat-runs/{id}/cancel` remains the backend semantic cancel. The Next BFF
route is the only browser caller.

### 8.3 Frontend API

`openGenerationRunStream` stays the single non-hook opener for `/stream/*`.

`useChatRunTail` remains the chat imperative multi-run tailer and the test seam.
Its public shape gains live-state callbacks/data, but no surface opens SSE
directly.

`apps/web/src/lib/api/sse/events.ts` owns the new strict event decoders. No
surface-level parser is allowed.

---

## 9. Capability Contract

Provider-runtime capability truth:

- stream event support by model/route;
- tool-call streaming granularity;
- provider artifacts;
- usage timing;
- request id availability;
- cancellation behavior;
- timeout limits;
- structured-output streaming support.

Nexus chat capability truth:

```python
ChatStreamingCapability(
    model_ref=...,
    can_stream_text=True,
    can_stream_tool_inputs=cap.stream.tool_call_delta,
    can_cancel=cap.stream.cancellation != "none",
    activity_level="provider" | "derived" | "minimal",
    timeout_policy=...,
)
```

Frontend model UI uses this only to render honest affordances:

- hide stop only if cancellation is truly unsupported;
- do not show partial tool inputs when provider/runtime cannot produce them;
- show generic activity if provider has no activity events;
- never infer unsupported features from provider name.

---

## 10. Files To Change

### 10.1 `../llm-calling`

- `src/provider_runtime/types.py`
  - delete exported `ModelChunk`;
  - add stream event union and invariants;
  - add `StreamCapabilities` or move capability type to `catalog.py`.
- `src/provider_runtime/__init__.py`
  - export new event types;
  - remove `ModelChunk`.
- `src/provider_runtime/runtime.py`
  - `ModelRuntime.stream()` returns `AsyncIterator[ModelStreamEvent]`;
  - accepts cancellation signal and timeout policy.
- `src/provider_runtime/_adapter_runtime.py`
  - shared stream assembler;
  - retry cutoff on visible events/artifacts;
  - terminal/cancel/failure enforcement.
- `src/provider_runtime/openai.py`
- `src/provider_runtime/anthropic.py`
- `src/provider_runtime/gemini.py`
- `src/provider_runtime/openai_compatible.py`
  - parse provider wire streams into typed events;
  - emit tool-call starts/deltas/done where possible;
  - emit opaque provider artifacts;
  - preserve terminal usage/status/request ids.
- `src/provider_runtime/catalog.py`
  - add `stream` capability block per model/route.
- `src/provider_runtime/testing.py`
  - scripted stream events, not chunks.
- Tests:
  - `tests/test_types.py`
  - `tests/test_runtime.py`
  - `tests/test_openai.py`
  - `tests/test_anthropic.py`
  - `tests/test_gemini.py`
  - `tests/test_openai_compatible.py`
  - `tests/test_catalog.py`
  - `tests/test_testing.py`
  - `tests/live/test_provider_matrix.py`

### 10.2 Nexus backend

- `python/nexus/schemas/conversation.py`
  - replace chat run SSE event union;
  - add payloads for activity/tool deltas/tool results;
  - remove old `delta`, `tool_call`, `retrieval_result` payloads.
- `python/nexus/services/chat_runs.py`
  - consume `ModelStreamEvent`;
  - add cancellation race;
  - use text coalescer;
  - map provider tool events to durable tool events;
  - finalize terminal status from stream terminal events.
- `python/nexus/services/chat_run_event_store.py`
  - validate new event grammar;
  - append coalesced events;
  - keep terminal safeguards.
- `python/nexus/services/chat_run_response.py`
  - materialize pending assistant text/trust state from event rows;
  - return `stream_state` cursor.
- `python/nexus/services/chat_run_finalize.py`
  - terminal `done` payload fields align with new grammar.
- `python/nexus/services/llm_ledger.py`
  - stream-quality metrics;
  - cancellation terminal outcome;
  - first-visible/first-provider timings.
- `python/nexus/api/routes/chat_runs.py`
  - response schema for `stream_state`;
  - cancel route semantics if needed.
- `python/nexus/api/routes/stream.py`
- `python/nexus/api/routes/_sse.py`
  - route likely unchanged; tests pin no regression.
- `python/nexus/db/models.py`
  - chat event CHECK update;
  - optional streaming metrics columns.
- `migrations/alembic/versions/*`
  - hard-cutover event CHECK/migration;
  - optional metrics columns.
- Tests:
  - `python/tests/test_chat_runs.py`
  - `python/tests/test_chat_run_stream.py`
  - `python/tests/test_sse.py`
  - `python/tests/test_stream_listen.py`
  - `python/tests/test_openai_reasoning_contracts.py`
  - `python/tests/test_run_kit.py`
  - `python/tests/test_cutover_negative_gates.py`

### 10.3 Nexus frontend

- `apps/web/src/lib/api/sse/events.ts`
  - new chat event decoders.
- `apps/web/src/lib/api/sse/events.test.ts`
  - strict acceptance/rejection for new grammar.
- `apps/web/src/lib/api/sse-client.ts`
  - cancellation/reconnect telemetry hooks if needed;
  - no per-surface token flow.
- `apps/web/src/lib/api/useGenerationRun.ts`
  - opener remains the only path builder.
- `apps/web/src/components/chat/useChatRunTail.ts`
  - cursor-based reconcile;
  - live state machine;
  - cancel integration;
  - no char-length skip.
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
  - event-sequence folding;
  - new event grammar;
  - ordered flushes.
- `apps/web/src/components/chat/useConversation.ts`
  - expose live state and stop action.
- `apps/web/src/components/chat/ChatComposer.tsx`
  - send/stop affordance wiring if composer owns action placement.
- `apps/web/src/components/chat/AssistantMessage.tsx`
  - safe activity/partial tool/reconnect/cancel display.
- `apps/web/src/components/chat/ChatSurface.tsx`
- `apps/web/src/components/chat/useChatScroll.ts`
  - verify no scroll jitter under high-frequency updates.
- `apps/web/src/components/ui/MarkdownMessage.tsx`
  - streaming-tail render optimization pinned by long-answer tests.
- Tests:
  - new `apps/web/src/components/chat/useChatRunTail.test.tsx`
  - `apps/web/src/components/chat/useChatMessageUpdates.test.tsx`
  - `apps/web/src/components/chat/useConversation.test.tsx`
  - `apps/web/src/__tests__/components/ChatSurface.test.tsx`
  - `apps/web/src/lib/api/sse-client.test.ts`
  - `apps/web/src/lib/api/useGenerationRun.test.tsx`
  - E2E chat/reconnect/cancel specs.

### 10.4 Docs

- Update `docs/modules/llms.md` to describe `ModelStreamEvent`.
- Update `docs/modules/chat.md` to describe new chat stream event grammar and
  cursor-based replay.
- Update `docs/architecture.md` SSE/chat sections if names or invariants change.
- Keep this cutover doc as the implementation tracker.

---

## 11. Duplicate Patterns To Delete Or Consolidate

| Current pattern | Final owner |
|---|---|
| Public `ModelChunk` with optional fields | `ModelStreamEvent` tagged union |
| Per-adapter tool-call accumulation semantics | Shared provider-runtime stream assembler |
| Per-adapter terminal usage/status quirks | Shared terminal event construction |
| Nexus per-provider stream assumptions | Provider-neutral stream event match |
| Per-provider chunk -> DB event append per text chunk | Chat text coalescer |
| Frontend char-count replay skip | Backend snapshot cursor + SSE `after` |
| Local SSE abort as "stop" | Backend cancel route + provider stream close |
| Generic pending gutter only | Live state machine |
| Tool status only after complete tool call | tool start/delta/done/result timeline |
| Generic SSE tests only | Direct chat-tail/reconnect/cancel tests |
| Live text-stream test only in provider matrix | Live streaming tool-call + artifact tests |

Do not delete:

- `run_kit`;
- `chat_run_events`;
- `sseClientDirect`;
- `openGenerationRunStream`;
- `useChatRunTail` module path;
- `useChatMessageUpdates`;
- `ChatSurface` scroll ownership;
- `ProviderArtifact` opacity;
- `llm_ledger`;
- `/stream/*` token model.

---

## 12. Composition With Existing Systems

### 12.1 Jobs

The worker still owns execution. Stream disconnects never affect in-flight
work. Job retries own durable re-execution only before user-visible streamed
output has become terminal app state. Provider-runtime retries remain inside
one provider operation and stop after visible stream events escape.

### 12.2 `llm_ledger`

`observed_generate_stream` wraps the new `ModelStreamEvent` iterator. It records:

- first provider event timestamp;
- first visible text timestamp;
- first tool event timestamp;
- provider event count;
- terminal event type;
- cancellation requested/completed timestamps;
- provider request id;
- usage;
- retry attempts.

The ledger remains operator-only and never stores hidden reasoning artifacts.

### 12.3 Trust Trail

The trust trail remains the product read model over durable rows. Live stream
events fold into the same frontend `trust_trail` shape that reload returns.
Provider activity events may inform UI state, but hidden provider reasoning
does not become trust-trail content.

### 12.4 Citations

Citations are not a streaming-transport concern. `citation_index` remains the
backend-built citation read model. The stream cutover must not reintroduce
frontend citation reconstruction from markdown or retrieval blocks.

### 12.5 Resource Chat

Resource chat adapters do not own streaming. They pass subject context to the
shared chat engine. Any streaming change that touches `ResourceChatDetail` must
be mechanical wiring to shared `useConversation` state only.

### 12.6 Oracle, LI, and Media Streams

This cutover targets chat token streaming. Oracle, LI, and media must continue
to use the shared `/stream/*` client; they do not adopt chat text/tool event
grammar. Negative gates must prevent new per-surface stream token/reconnect
implementations from appearing while this work is in flight.

### 12.7 BYOK, Budget, And Rate Limits

No special streaming path bypasses key resolution, budget reservation, rate
limit slots, or ledger rows. Cancellation releases reserved budget/slots in the
same owner layer as other terminal paths.

### 12.8 SSR First Paint

This is chat token streaming, not first-paint streaming. It must not reintroduce
data-gated TTFB, client restore round trips, or SSR waterfalls. Chat surfaces
render pending rows quickly using existing shell/bootstrap behavior.

---

## 13. Key Decisions

1. Replace the public `ModelChunk` stream contract with `ModelStreamEvent`.
   Optional-field chunks are too lossy for tool streaming, cursor replay, and
   terminal semantics.

2. Keep SSE and `/stream/*`. The transport is already correct for replayable
   durable events; the missing sophistication is event contracts and folding.

3. Use bounded coalescing, not raw per-token commits or purely client-side
   smoothing. The DB remains truth, but text events must be shaped for durable
   UX and write load.

4. Resume by DB sequence, not text length. Text length is a rendering artifact;
   event `seq` is the durable cursor.

5. Materialize pending chat state on `GET /chat-runs/{id}`. Reconcile must
   return enough state to resume cleanly without asking React to infer truth.

6. Make cancellation a backend semantic action. Local abort remains a view
   lifecycle tool, not user stop.

7. Show safe activity, not hidden reasoning. "Thinking" is a phase; reasoning
   content remains opaque provider continuity data.

8. Tool-call deltas are render-only until `tool_call_done`. Partial input is
   useful for UI but not executable truth.

9. Preserve `useChatRunTail` as the chat orchestration seam. The generic stream
   hook cannot own branch visibility, active-path filtering, optimistic
   messages, or multi-run chat-specific reconciliation.

10. Provider-runtime live tests must include streaming tool calls. Non-streamed
    forced tool continuation does not prove the chat path.

---

## 14. Acceptance Criteria

AC-1 Provider stream contract. `provider_runtime.__init__` exports
`ModelStreamEvent` and does not export `ModelChunk`. Unit tests prove strict
event invariants and exactly one terminal event.

AC-2 Provider adapter fidelity. OpenAI, Anthropic, Gemini, and OpenAI-compatible
adapters produce text, tool start/delta/done, provider artifact, usage, request
id, and terminal events where supported. Unsupported features are represented by
catalog capabilities, not silent missing fields.

AC-3 Runtime retry/cancel. Runtime retries streaming only before any visible
text, tool event, or provider artifact escapes. Cancellation closes the provider
stream and yields/raises a normalized cancellation outcome.

AC-4 Live provider streaming tools. The live matrix includes streaming forced
tool-call tests with continuation for every capable provider/model route, plus
reasoning/artifact replay where supported.

AC-5 New chat event grammar. Backend DB CHECK, Pydantic schemas, frontend SSE
parsers, and tests accept only `assistant_activity`, `assistant_text_delta`,
`tool_call_start`, `tool_call_delta`, `tool_call_done`, `tool_result`,
`citation_index`, `context_ref_added`, `meta`, and `done`.

AC-6 Coalescing. A long provider text stream writes fewer durable text events
than provider text deltas while preserving configured latency bounds and final
answer exactness.

AC-7 Cursor replay. Reconnect after partial output performs
`GET /chat-runs/{id}`, receives `stream_state.folded_event_seq`, opens SSE with
`after` that sequence, and shows no duplicate or missing text. No char-count
skip exists.

AC-8 Cancellation UX. A visible stop action cancels a running chat, backend
closes provider work promptly, terminal `done {status:"cancelled"}` arrives,
budget/slots are released, and local UI never reports a completed answer.

AC-9 Partial-output failure. If a provider stream fails after visible output,
Nexus does not provider-retry. It preserves partial text, records ledger/error
detail, emits terminal failed/interrupted state, and offers the existing retry
affordance.

AC-10 Frontend smoothness. Text deltas are RAF-batched, older message rows do
not remount every frame, scroll anchoring remains stable, and long markdown
answers remain responsive.

AC-11 State display. The assistant row can display queued, thinking, writing,
tool calling, running tool, reconnecting, cancelling, cancelled, failed, and
complete states without exposing hidden reasoning.

AC-12 All chat adapters. Full chat and every resource-subject/reader/media/LI
chat adapter use the same `useConversation` -> `useChatRunTail` stream path.

AC-13 Observability. `llm_calls` or associated logs expose first provider event,
first visible text, provider event count, durable flush count, SSE reconnects,
cancel latency, terminal cause, and provider request id.

AC-14 Real DB/HTTP stream test. A test opens
`/stream/chat-runs/{id}/events`, inserts events after the connection is open,
and verifies LISTEN/NOTIFY plus cursor replay deliver them without polling.

AC-15 E2E. Browser tests cover send, visible streaming, reconnect without
duplication, stop/cancel, reload while running, and final reconcile/citation
state.

---

## 15. Negative Gates

- No exported `ModelChunk` from `provider_runtime`.
- No `delta`, `tool_call`, or `retrieval_result` chat SSE event names outside
  migrations or this spec.
- No frontend `replayDeltaCharsToSkip` or equivalent text-length replay skip.
- No `fetchStreamToken` calls from chat/oracle/LI/media surface modules; the
  single opener remains the owner.
- No direct `sseClientDirect` calls from chat/oracle/LI/media surface modules;
  they use `openGenerationRunStream` / `useGenerationRun` / `useChatRunTail`.
- No provider-specific stream event branching in Nexus chat execution.
- No `append_and_commit` per provider `text_delta` without passing through the
  coalescer.
- No local-only stop action that skips `POST /chat-runs/{id}/cancel`.
- No hidden reasoning content in logs, DB event payloads, trust trail payloads,
  or frontend props.
- No live provider matrix that tests streaming text only while tool calls remain
  non-streamed.

Must remain:

- `/stream/*` direct FastAPI SSE exception with fresh single-use token per
  connect;
- `Last-Event-ID` support;
- committed event rows as source of truth;
- `run_kit` terminal ownership;
- provider artifacts opaque and in-memory only for chat tool continuation;
- `useChatRunTail` chat orchestration layer;
- chat citations as backend-built read models.

---

## 16. Implementation Sequence

S0. Provider-runtime spec tests.

- Add failing tests for stream event union invariants.
- Add adapter golden tests for provider text/tool/artifact/terminal events.
- Add cancellation and retry-cutoff tests.

S1. Provider-runtime implementation.

- Add `ModelStreamEvent` types and catalog stream capabilities.
- Rewrite adapters to emit typed events.
- Delete public `ModelChunk`.
- Update fake/scripted runtime.
- Extend live matrix for streaming tool calls.

S2. Nexus provider-runtime pin and compile break.

- Bump `provider-runtime` git rev.
- Let type/runtime failures identify all `ModelChunk` call sites.
- Update `llm_ledger.observed_generate_stream` first, then chat execution.

S3. Backend chat event grammar and migration.

- Add new Pydantic payloads.
- Update DB CHECK/migration.
- Implement provider-event -> chat-event mapping.
- Implement text coalescer.
- Update terminal `done` payload.

S4. Cursor materialization.

- Teach `chat_run_response` to fold pending event rows.
- Add `stream_state`.
- Update create/resume/reconcile callers.
- Delete char-count replay skip.

S5. Cancellation.

- Add provider-runtime cancellation signal path.
- Race chat worker provider reads against cancel.
- Wire frontend stop action to backend cancel route.
- Ledger cancel outcome.

S6. Frontend grammar/state.

- Replace SSE event decoders.
- Update `useChatRunTail`, `useChatMessageUpdates`, `useConversation`.
- Add live states and UI affordances.
- Verify scroll and markdown performance.

S7. Verification and negative gates.

- Add direct chat tail tests.
- Add real DB/HTTP stream integration test.
- Add browser/E2E reconnect/cancel/reload tests.
- Add provider-runtime live streaming tool tests.
- Add grep gates.

S8. Docs.

- Update `docs/modules/llms.md`, `docs/modules/chat.md`, and
  `docs/architecture.md`.
- Mark this spec implemented with any post-implementation corrections.

All slices land as one hard cutover branch for merge. Intermediate commits may
be reviewable, but main must never contain a dual public stream contract.

---

## 17. Test Plan

### 17.1 Provider-runtime unit/golden

- Event type invariants:
  - common fields present;
  - monotonic sequence;
  - terminal exactly once;
  - non-terminal usage only via `usage_delta`;
  - opaque artifacts not stringified in repr.
- Retry:
  - retry before first event;
  - no retry after text;
  - no retry after tool delta;
  - no retry after provider artifact.
- Cancellation:
  - before provider request;
  - during provider read before output;
  - after visible output.
- Provider adapters:
  - OpenAI function-call arguments stream as deltas and done;
  - Anthropic `input_json_delta` streams as deltas;
  - Gemini thought signatures captured and hidden thought text excluded;
  - OpenAI-compatible tool-call accumulation emits start/delta/done.

### 17.2 Nexus backend

- Schema rejects old event names.
- Coalescer flushes on interval, cap, tool event, terminal, cancel, exception.
- Chat execution maps provider events into durable chat events.
- `GET /chat-runs/{id}` materializes pending text and cursor from event rows.
- Reconnect path starts after folded cursor.
- Cancel route finalizes with `E_CANCELLED`.
- Partial-output provider failure preserves partial text and terminal failure.
- LISTEN/NOTIFY integration delivers events inserted after stream open.
- `llm_calls` captures stream quality metrics.

### 17.3 Frontend unit/browser

- SSE parser accepts new event grammar and rejects old event names.
- `useChatRunTail`:
  - starts after reconcile cursor;
  - dedupes old seq;
  - reconciles after reconnect;
  - handles terminal done;
  - handles cancel;
  - handles partial failure.
- `useChatMessageUpdates`:
  - folds ordered text/tool/activity events;
  - flushes text before tool and terminal events;
  - ignores duplicate/older seq.
- `AssistantMessage` renders safe activity and stop states.
- `ChatSurface` scroll anchoring remains stable while text streams.
- `MarkdownMessage` long streaming answer remains responsive.

### 17.4 E2E

- Send a chat and observe visible incremental text before terminal.
- Drop/restart SSE connection and verify no duplicate text.
- Reload while run is active and verify materialized pending text resumes from
  cursor.
- Stop a running chat and verify terminal cancelled UI.
- Provider/tool fixture stream emits tool-call input deltas and final tool
  result.
- Citation chips survive terminal reconcile.

### 17.5 Live providers

Run only with secrets:

```bash
make test-live-providers
```

Required additions:

- streaming text for every stream-capable generation catalog row;
- streaming forced tool call plus continuation for every capable row;
- reasoning/artifact replay with streaming tool calls for OpenAI, Anthropic,
  Gemini where supported;
- cancellation smoke where provider route can be safely cancelled.

---

## 18. Risks And Mitigations

R1. Provider APIs differ more than the event union allows.

Mitigation: keep `raw_metadata` for safe metadata, but do not expose raw content
or provider bodies. Add fields only when tests prove cross-provider value.

R2. Coalescing makes text feel less immediate.

Mitigation: 33ms default interval, flush on first text immediately, frontend
RAF batching. Acceptance checks first-visible text and flush cadence.

R3. Pending snapshot folding is expensive for very long runs.

Mitigation: one-user prototype accepts folding from event rows. If measured
expensive later, add a server-owned materialized cursor/snapshot table in a
separate design, not a frontend heuristic.

R4. Cancellation watcher adds polling.

Mitigation: prefer DB notification or worker-local signal; if bounded polling
is used, add `justify-polling` and named timing constants.

R5. Tool-call partial input could leak sensitive arguments.

Mitigation: render only provider/runtime-marked safe parsed input. Never render
raw partial JSON if the tool is not allowlisted for safe display.

R6. Hard cutover touches two repos.

Mitigation: provider-runtime branch lands first, Nexus pin moves in the same
cutover branch, and type failures are used as intended breakpoints.

R7. Old dev DB event rows fail parsing.

Mitigation: migration deletes or normalizes old chat event rows for non-terminal
local data. Production acceptance targets current app state, not legacy dev
history.

---

## 19. Rejected Alternatives

### WebSockets

Rejected. Bidirectional transport does not solve provider stream semantics,
durable replay, cancellation, or UI folding. SSE already matches persisted
append-only event delivery.

### Adopt AI SDK end to end

Rejected as a substrate. AI SDK is a useful reference for typed data streams and
tool-call streaming UI, but Nexus needs Python/FastAPI, provider artifact
fidelity, BYOK, ledger, durable ChatRun, citations, and resource graph
composition. A wholesale adoption would move ownership to the wrong layer.

### Keep `ModelChunk` and add optional fields

Rejected. Optional-field chunks are the current source of ambiguity. A tagged
union is stricter, easier to test, and maps cleanly to UI state.

### Client-only smoothing

Rejected. RAF batching is necessary but not sufficient. Backend write cadence
and replay cursor semantics are owner-layer concerns.

### Snapshot-only pending text on reconnect

Rejected. Snapshot is used for reconcile, but SSE must continue from a durable
event cursor so live state, tool events, and terminal events are not lost.

### Provider-side conversation ids

Rejected as default. Provider-managed state would weaken Nexus replay,
observability, portability, and BYOK/provider symmetry.

---

## 20. Done Means

- The public provider-runtime stream contract is event-union based.
- Nexus chat streams from that contract with bounded coalescing.
- All chat UIs share the same stream engine and live state.
- Reconnect is cursor-based and deterministic.
- Stop cancels provider work, not just the local stream.
- Live provider tests prove streaming tool calls and continuation.
- Old event names, chunk contracts, and replay heuristics are gone.
- Docs and negative gates pin the final state.
