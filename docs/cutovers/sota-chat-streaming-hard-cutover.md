# SOTA Chat Streaming Hard Cutover

> **Generation-backend amendment (2026-08-31):**
> [`generation-backends-hard-cutover.md`](generation-backends-hard-cutover.md)
> supersedes every Codex-only wire, fixed profile/plan, `ChatTools`, and
> single-call ledger statement below. This document remains authoritative only
> for browser-facing Chat event coalescing, SSE cursor replay, cancellation,
> reconnect, and smooth rendering of route-neutral generation events.

Status: BUILT - 2026-06-20
Author altitude: SME / staff
Date: 2026-06-18 (spec) / 2026-06-20 (built)
Type: hard cutover - no legacy paths, no fallbacks, no backward compatibility,
no compatibility shims, no dual stream contracts.

Built: the streaming transport, event grammar, coalescing, cursor replay, and
cancellation merged 2026-06-18 (`946c0fb7`). The final AC-10 frontend-smoothness
piece landed 2026-06-20 — older transcript rows now skip re-render during
streaming via `React.memo(MessageRow)` over referentially-stable row props
(completed messages were already memoized in `MarkdownMessage`).

Supersedes the chat-streaming assumptions in:

- Earlier chat contracts that treat `ModelChunk`, chat SSE `delta`, or
  char-count replay skipping as sufficient long-term contracts.

Does not supersede:

- the durable generation harness;
- the private Codex generation host as the only generation wire owner;
- `run_kit` as the durable event/terminal owner;
- `/stream/*` as the browser-to-FastAPI SSE exception;
- `llm_ledger` as the unified generation execution ledger;
- chat branching, prompt assembly, citations, search tools, or resource-subject
  chat ownership.

---

## 0. North Star

Every chat in Nexus streams like a modern agent product: immediate local send,
clear pre-token activity, smooth text arrival, visible tool intent as soon as
the Codex turn exposes it, prompt cancellation that actually aborts work, durable
reconnect without duplicate or missing text, complete terminal usage/error
recording, and reload parity.

The architecture remains strict:

```text
private v2 UDS NDJSON stream
  -> codex_generation_client typed frames
  -> Nexus chat run execution and durable event log
  -> /stream/chat-runs/{id}/events cursor tail
  -> frontend fold/reconcile state
  -> ChatSurface render and scroll behavior
```

Transport is still a dumb pipe. The fixed plan and Codex wire semantics live at
the generation boundary. Nexus still owns durable app state. The frontend still
renders from typed domain events and reconciles against persisted truth.

The cutover upgrades the weakest layer boundaries instead of papering over them:

- Nexus maps the one bounded Codex frame stream into its durable product event
  grammar.
- Nexus stops treating host text frames as a per-frame DB commit stream.
- Chat replay stops depending on assistant-text length heuristics.
- Cancellation stops being only a local SSE detach or a flag checked after the
  generation stream eventually yields.
- Tests stop proving only generic SSE plumbing and start proving live chat UX.

---

## 1. SME Thesis

The product already has the right skeleton: durable `ChatRun`, worker-owned
execution, persisted events, `/stream/*` tokens, `Last-Event-ID`, `run_kit`,
`llm_ledger`, and a shared frontend stream opener. The professional move is not
to swap SSE for WebSockets or import a chat framework wholesale.

The professional move is to make each boundary carry the information it owns:

- the private generation client exposes strict, contiguous v2 frames and one
  closed terminal;
- Nexus translates those frames into a compact durable chat event grammar;
- `GET /chat-runs/{id}` can materialize a pending run from persisted events and
  return a cursor, so SSE resume starts after known state;
- the frontend folds by event sequence, not by text length;
- cancellation and timeout policy come from the fixed chat plan;
- observability measures first-visible-text and streaming quality, not just
  final success;
- tests exercise Codex/MCP tool streaming, reconnect, cancel, and long-message
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
- `codex_generation_client` now owns the private v2 frame iterator; the durable
  chat grammar below remains the browser-facing projection and never becomes a
  second generation protocol.

### 2.2 Streaming gaps this cut owns

- Nexus must coalesce non-empty host text frames instead of committing each one.
- `useChatRunTail` must resume by a persisted event cursor, never assistant-text
  length.
- Backend cancellation must race the generation read and invoke the private v2
  cancel endpoint.
- The UI needs a complete safe activity/reconnect/cancel state without hidden
  reasoning content.
- Direct tests must cover chat-specific tailing, visible cancel, DB/HTTP
  streaming after open, browser reconnect, and Codex/MCP tool activity.

---

## 3. Hard-Cutover Posture

- No direct-provider generation stream or Nexus-side alternative to the private
  v2 UDS frame contract.
- No old chat SSE event parser fallback. The frontend validates only the new
  event grammar.
- No dual event names such as `delta` plus `assistant_text_delta`.
- No frontend char-count replay skip.
- No route-specific generation branching in Nexus chat execution; it consumes
  only `GenerationFrame`.
- No transport-driven execution path. The worker still owns the run; the stream
  only tails rows.
- No hidden reasoning, prompt, credential, raw command, native artifact, or raw
  host frame in product UI, logs, or persisted chat events.
- No WebSocket parallel path.
- No fallback or automatic redispatch after host acceptance. A stream loss
  without a terminal leaves the durable generation `Uncertain`.
- No product structured-output stream for chat. The admitted route-neutral
  generation emits text/tool/usage/native/terminal frames under the current
  generation contract.
- No compatibility migrations that preserve old event rows as first-class data.
  If local/dev rows exist, the migration can delete or normalize them as a
  one-time hard cutover.

Keeping a good current name is allowed only when it remains the single current
contract. Keeping an old name as a second accepted payload shape is not allowed.

---

## 4. Goals

G1. One generation stream seam. Chat consumes route-neutral `GenerationEvent`
values from the exact admitted backend; selection, bounds, route-local wire,
terminal, and uncertainty rules stay owned by the
[generation backends cutover](generation-backends-hard-cutover.md).

G2. Smooth durable chat text. Nexus coalesces host text frames into bounded,
low-latency durable events instead of committing every host frame.

G3. Cursor-based replay. Chat reconcile returns a materialized pending message
plus an event cursor. SSE resumes after that cursor. No text-length replay skip.

G4. Real cancellation. A user stop action calls the backend cancel route and the
worker races generation reads against cancellation, invokes private
`POST /v2/generations/{request_id}/cancel`, and waits for the normalized
terminal when the stream remains available.

G5. Rich safe activity. Chat can show safe live states such as queued,
thinking, writing, calling tool, searching, reading, reconnecting, cancelling,
cancelled, failed, and complete without exposing hidden reasoning content.

G6. One frontend stream fold. Full chat, resource chat, reader/media quote chat,
and library-intelligence subject chat all flow through `useConversation`,
`useChatRunTail`, and `useChatMessageUpdates`.

G7. Observable streaming quality. Operator state includes
time-to-first-visible-text, durable flush count, SSE reconnect count, cancel
latency, and terminal cause without adding provider diagnostics to the ledger.

G8. Production-grade proof. Tests cover the production v2 client against a
protocol-valid UDS peer, Nexus durable mapping, DB/HTTP streaming after
connection open, frontend reconnect/cancel, long-message rendering, and the
protected Codex/MCP smoke.

---

## 5. Non-Goals

N1. No WebSockets, WebRTC, Realtime API, or bidirectional voice/audio transport
for text chat. SSE remains correct for durable text/event delivery.

N2. No native continuation identifier in product intent. Each chat generation
opens one native turn; Nexus owns conversation, prompt, tool, and replay state.

N3. No streaming hidden reasoning or native artifact content. Such frames are
never product events, logs, or ledger data.

N4. No generic stream broker. Postgres event rows plus LISTEN/NOTIFY are enough
for the prototype and already match repo doctrine.

N5. No token-perfect UI guarantee. The UI promises smooth text and exact final
content, not one DOM update per host text frame.

N6. No rewrite of chat branching, search, citations, trust trail, resource
subjects, or prompt assembly except where the streaming contract directly
touches them.

N7. No product token streaming for Oracle or library-intelligence synthesis.
They use the same generation boundary but keep their domain event grammar.

N8. No usage/price dashboard. Streaming metrics are bounded operator logs or
test evidence, not product UI or new ledger columns.

---

## 6. Scope

In scope:

- the narrow `GenerationFrame`-to-chat-event adapter; generation wire and plan
  implementation remain owned by the Codex generation cutover;
- Nexus chat run execution, event schemas, DB event grammar, coalescing,
  cancellation, response materialization, telemetry, tests, and migrations.
- Nexus frontend chat stream parsing/folding, status state, stop action, scroll
  and markdown rendering behavior, and tests.
- Docs and negative gates that pin the new contract.

Out of scope:

- embeddings and transcription;
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

### 7.1 Generation stream seam

Chat executes the persisted `GenerationSpec` through `GenerationService` and
receives bounded route-neutral `GenerationEvent` values from either backend.
The adapter owns route-specific continuity and validates exactly one terminal;
Chat owns only their projection into durable product events. A frozen
`ModelTools` plan alone admits tool use, approvals are never granted, and
unknown/gapped/missing-terminal streams fail closed.

This document owns only the mapping into durable chat events. Command shape,
exact-selection resolution, frame bounds, cancellation, normalized terminal
failures, parent/child generation replay, and tool-loop continuations are
defined by
[`generation-backends-hard-cutover.md`](generation-backends-hard-cutover.md)
and [`../modules/llms.md`](../modules/llms.md). This streaming document owns no
catalog, credential, route, fallback, or retry policy.

### 7.2 Nexus durable chat event grammar

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
- Every generation-frame-derived event includes the retained wire fields
  `provider_event_seq_start` and `provider_event_seq_end`; they carry the host
  frame sequence and do not identify a provider route.
- Every durable event has DB `seq`; that DB `seq` is the only replay cursor.
- `assistant_text_delta.text` is non-empty visible text. It may coalesce many
  host `text` frames.
- Tool-call delta events are safe to render as partial input, but never execute
  tools. Execution starts only after `tool_call_done`.
- `tool_result` is the shared result event for app search, web search,
  read-resource, inspect-resource, and future tools. Retrieval-bearing results
  carry trust-trail/retrieval payloads; non-retrieval results carry safe status.
- `done` is the sole terminal event and carries:
  `{status, error_code, final_chars, last_provider_event_seq, usage?, cancelled?}`.

### 7.3 Backend coalescing

Host text frames pass through a bounded coalescer before durable append:

```python
CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
```

Flush triggers:

- interval elapsed;
- char/byte cap reached;
- assistant activity changes away from writing;
- tool event arrives;
- a non-text generation frame arrives;
- cancellation requested;
- stream terminal event arrives;
- local max assistant length approaches;
- exception path before finalization.

The coalescer is local to `execute_chat_run`. It does not own transport and it
does not buffer terminal events. It reduces write volume while preserving a
sub-frame UI cadence once the frontend RAF-batches.

### 7.4 Cursor-based materialization and replay

`GET /chat-runs/{id}` returns a server-materialized run snapshot:

```json
{
  "run": { "...": "existing fields" },
  "messages": [],
  "stream_state": {
    "status": "queued|running|complete|error|cancelled",
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

### 7.5 Cancellation

Frontend stop action:

- calls `POST /api/chat-runs/{runId}/cancel`;
- sets local status to `cancelling`;
- keeps the SSE open until `done {status:"cancelled"}` or a reconciled terminal
  cancelled state arrives;
- local `AbortController` detaches only when leaving the view or after terminal.

Backend execution:

- cancel route sets `chat_runs.cancel_requested_at`;
- worker races generation-frame reads against a cancellation watcher;
- cancellation watcher is push-first. Bounded polling is permitted only when it
  is documented with `justify-polling` and named timing constants;
- when cancel wins, worker invokes private
  `POST /v2/generations/{request_id}/cancel`, flushes any text coalescer buffer,
  and keeps consuming the still-open stream. A returned cancelled terminal is
  staged with `Completed`, finalizes `E_CANCELLED`, and appends `done`; a lost
  accepted stream without terminal remains `Uncertain` and emits no fabricated
  terminal.

### 7.6 Timeout policy

Chat timeout is frozen in the admitted `GenerationSpec`. `generation_policy.py`
owns the 900-second Chat tool-plan ceiling plus session-open, runtime-close,
transport, and stream bounds; the browser and chat caller cannot tune them. A closed typed
timeout/output-limit terminal becomes the corresponding product failure. Loss
after host acceptance without a terminal preserves partial durable text and the
`Uncertain` generation; it is not a timeout card or automatic redispatch.

### 7.7 Frontend stream state

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
- partial tool input only if the strict durable tool event marks it safe and
  parsed enough;
- no hidden reasoning content.

### 7.8 Frontend text folding and rendering

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
- scroll anchoring continues to be owned by `ChatSurface` / `useChatScroll`; the
  transcript anchoring *behavior* (hybrid pin-to-top then stick-to-bottom) is
  specified by `docs/cutovers/chat-scroll-anchoring-hard-cutover.md`. This
  cutover only guarantees the coalesced streaming cadence does not regress it.

---

## 8. API Design

### 8.1 Generation boundary API

There is no product generation-stream API in this cutover. Chat consumes the
production `CodexGenerationClient` frame iterator and cancel control through
the shared execution service. The private `/v2/generations` command, frame, and
terminal schemas are not duplicated here.

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

The exact per-run generation selection and independently admitted Chat tool plan
own incremental text, route-neutral tool execution, explicit cancel,
stream/timeout bounds, and one closed terminal. The frontend receives safe
durable activity and tool projections only; it never infers a route or fallback
from stream events. A partial tool input renders only when the strict Chat event
carries a safe projection and is never executable truth.

---

## 10. Files To Change

### 10.1 Nexus backend

- `python/nexus/schemas/conversation.py`
  - replace chat run SSE event union;
  - add payloads for activity/tool deltas/tool results;
  - remove old `delta`, `tool_call`, `retrieval_result` payloads.
- `python/nexus/services/chat_runs.py`
  - consume `GenerationFrame`;
  - add cancellation race;
  - use text coalescer;
  - map host/tool frames to durable product events;
  - finalize only from the closed generation terminal.
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
  - unified staged generation terminal and normalized usage only.
- `python/nexus/api/routes/chat_runs.py`
  - response schema for `stream_state`;
  - cancel route semantics if needed.
- `python/nexus/api/routes/stream.py`
- `python/nexus/api/routes/_sse.py`
  - route likely unchanged; tests pin no regression.
- `python/nexus/db/models.py`
  - chat event CHECK update.
- `migrations/alembic/versions/*`
  - hard-cutover event CHECK/migration.
- Tests:
  - `python/tests/test_chat_runs.py`
  - `python/tests/test_chat_run_stream.py`
  - `python/tests/test_sse.py`
  - `python/tests/test_stream_listen.py`
  - `python/tests/test_run_kit.py`
  - `python/tests/test_cutover_negative_gates.py`

### 10.2 Nexus frontend

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
  - verify no scroll jitter under high-frequency updates (the anchoring model is
    owned by `chat-scroll-anchoring-hard-cutover.md`; here only verify the
    coalesced cadence keeps it stable).
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

### 10.3 Docs

- Update `docs/modules/llms.md` only at the narrow Codex-frame/chat-event seam.
- Update `docs/modules/chat.md` to describe new chat stream event grammar and
  cursor-based replay.
- Update `docs/architecture.md` SSE/chat sections if names or invariants change.
- Keep this cutover doc as the implementation tracker.

---

## 11. Duplicate Patterns To Delete Or Consolidate

| Current pattern | Final owner |
|---|---|
| Generation wire interpretation in chat | `codex_generation_client` `GenerationFrame` |
| Host text frame -> DB append per frame | Chat text coalescer |
| Frontend char-count replay skip | Backend snapshot cursor + SSE `after` |
| Local SSE abort as "stop" | Backend cancel route + private v2 cancel |
| Generic pending gutter only | Live state machine |
| Tool status only after complete tool call | tool start/delta/done/result timeline |
| Generic SSE tests only | Direct chat-tail/reconnect/cancel tests |
| Surface-local stream openers | `openGenerationRunStream` / `useChatRunTail` |

Do not delete:

- `run_kit`;
- `chat_run_events`;
- `sseClientDirect`;
- `openGenerationRunStream`;
- `useChatRunTail` module path;
- `useChatMessageUpdates`;
- `ChatSurface` scroll ownership;
- `llm_ledger`;
- `/stream/*` token model.

---

## 12. Composition With Existing Systems

### 12.1 Jobs

The worker still owns execution. Stream disconnects never affect in-flight
work. The generation owner's `Prepared | Uncertain | Completed` journal owns
dispatch: an accepted stream loss is never automatically redispatched, and the
exact pre-accept capacity refusal is the only generation reschedule back to
`Prepared`.

### 12.2 `llm_ledger`

The unified ledger is staged by the generation owner, not by this streaming
adapter. Its one row records the fixed plan/revision, Codex route, normalized
terminal and usage, SDK/runtime versions, acceptance, and latency. It stores no
price, attempt trace, provider request id, hidden reasoning, raw frame, or
reconnect/flush telemetry; those last product-transport facts may be bounded
logs.

### 12.3 Trust Trail

The trust trail remains the product read model over durable rows. Live stream
events fold into the same frontend `trust_trail` shape that reload returns.
Safe assistant activity events may inform UI state, but hidden reasoning and
native frames do not become trust-trail content.

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

### 12.7 Generation admission

Streaming uses the operator's `codex-personal` subscription and the shared
turn-slot/concurrency admission. It has no BYOK, token-budget reservation,
provider price, or generation entitlement branch. Cancellation and terminal
cleanup release the same admitted host turn; the browser stream never owns that
resource.

### 12.8 SSR First Paint

This is chat token streaming, not first-paint streaming. It must not reintroduce
data-gated TTFB, client restore round trips, or SSR waterfalls. Chat surfaces
render pending rows quickly using existing shell/bootstrap behavior.

---

## 13. Key Decisions

1. Keep one generation wire: strict v2 `GenerationFrame` values over private
   UDS. This cutover begins only at their durable chat-event projection.

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
   and native continuity content never becomes product data.

8. Tool-call deltas are render-only until `tool_call_done`. Partial input is
   useful for UI but not executable truth.

9. Preserve `useChatRunTail` as the chat orchestration seam. The generic stream
   hook cannot own branch visibility, active-path filtering, optimistic
   messages, or multi-run chat-specific reconciliation.

10. The protected Codex/MCP smoke must prove incremental text, one tool call,
    continuation, cancellation, and the exact fixed plan/wire pins.

---

## 14. Acceptance Criteria

AC-1 Generation stream seam. Chat consumes only the production v2
`GenerationFrame` iterator; sequence is contiguous, terminal is last, and no
direct-provider generation stream or compatibility decoder exists.

AC-2 Frame projection. Host text/tool/usage frames map exhaustively into the
closed durable chat grammar; native/permission/policy violations never leak raw
content and follow the generation terminal contract.

AC-3 Uncertainty and cancel. A proven pre-accept capacity refusal alone may
restore `Prepared`; accepted loss without terminal remains `Uncertain` and is
not redispatched. Cancel invokes the private v2 endpoint and a returned
cancelled terminal completes the same generation.

AC-4 Protected streaming tools. The fixed Codex/MCP smoke proves incremental
text, one declared tool call and continuation, cancellation, exact model/effort,
and exact SDK/runtime/MCP pins.

AC-5 New chat event grammar. Backend DB CHECK, Pydantic schemas, frontend SSE
parsers, and tests accept only `assistant_activity`, `assistant_text_delta`,
`tool_call_start`, `tool_call_delta`, `tool_call_done`, `tool_result`,
`citation_index`, `context_ref_added`, `meta`, and `done`.

AC-6 Coalescing. A long host text stream writes fewer durable text events than
host text frames while preserving configured latency bounds and final
answer exactness.

AC-7 Cursor replay. Reconnect after partial output performs
`GET /chat-runs/{id}`, receives `stream_state.folded_event_seq`, opens SSE with
`after` that sequence, and shows no duplicate or missing text. No char-count
skip exists.

AC-8 Cancellation UX. A visible stop action cancels a running chat, backend
invokes private generation cancel promptly, terminal
`done {status:"cancelled"}` arrives when the host terminal is observed, the
turn slot is released, and local UI never reports a completed answer.

AC-9 Accepted stream loss. If the host stream is lost after acceptance without
a terminal, Nexus preserves partial text and leaves the generation `Uncertain`;
it emits no fabricated failed/interrupted terminal and offers no automatic
generation retry.

AC-10 Frontend smoothness. Text deltas are RAF-batched, older message rows do
not remount every frame, scroll anchoring (per
`chat-scroll-anchoring-hard-cutover.md`) remains stable, and long markdown
answers remain responsive.

AC-11 State display. The assistant row can display queued, thinking, writing,
tool calling, running tool, reconnecting, cancelling, cancelled, failed, and
complete states without exposing hidden reasoning.

AC-12 All chat adapters. Full chat and every resource-subject/reader/media/LI
chat adapter use the same `useConversation` -> `useChatRunTail` stream path.

AC-13 Observability. `llm_calls` exposes only its fixed plan, normalized
terminal/usage, versions, acceptance, and latency contract. Bounded associated
logs may expose first visible text, durable flush count, SSE reconnects, cancel
latency, and terminal cause without route/request diagnostics.

AC-14 Real DB/HTTP stream test. A test opens
`/stream/chat-runs/{id}/events`, inserts events after the connection is open,
and verifies LISTEN/NOTIFY plus cursor replay deliver them without polling.

AC-15 E2E. Browser tests cover send, visible streaming, reconnect without
duplication, stop/cancel, reload while running, and final reconcile/citation
state.

---

## 15. Negative Gates

- No direct-provider generation stream, `ModelChunk`/`ModelStreamEvent`
  generation consumer, or route/key/model/effort override in chat.
- No `delta`, `tool_call`, or `retrieval_result` chat SSE event names outside
  migrations or this spec.
- No frontend `replayDeltaCharsToSkip` or equivalent text-length replay skip.
- No `fetchStreamToken` calls from chat/oracle/LI/media surface modules; the
  single opener remains the owner.
- No direct `sseClientDirect` calls from chat/oracle/LI/media surface modules;
  they use `openGenerationRunStream` / `useGenerationRun` / `useChatRunTail`.
- No route-specific stream event branching in Nexus chat execution.
- No durable append per host `text` frame without passing through the
  coalescer.
- No local-only stop action that skips `POST /chat-runs/{id}/cancel`.
- No hidden reasoning content in logs, DB event payloads, trust trail payloads,
  or frontend props.
- No retry/fallback branch after an accepted generation stream becomes
  ambiguous.

Must remain:

- `/stream/*` direct FastAPI SSE exception with fresh single-use token per
  connect;
- `Last-Event-ID` support;
- committed event rows as source of truth;
- `run_kit` terminal ownership;
- native generation artifacts absent from product events and ledger rows;
- `useChatRunTail` chat orchestration layer;
- chat citations as backend-built read models.

---

## 16. Implementation Sequence

S0. Generation seam.

- Pin the production `GenerationFrame` iterator and closed terminal mapping.
- Prove v2 UDS sequence, terminal, cancel, capacity, and accepted-loss behavior
  through the shared execution boundary.
- Keep plan/ledger/uncertainty implementation in the Codex generation cutover.

S1. Backend chat event grammar and migration.

- Add new Pydantic payloads.
- Update DB CHECK/migration.
- Implement generation-frame -> chat-event mapping.
- Implement text coalescer.
- Update terminal `done` payload.

S2. Cursor materialization.

- Teach `chat_run_response` to fold pending event rows.
- Add `stream_state`.
- Update create/resume/reconcile callers.
- Delete char-count replay skip.

S3. Cancellation.

- Race chat worker generation reads against cancel and call private v2 cancel.
- Wire frontend stop action to backend cancel route.
- Stage the cancelled generation terminal through the unified ledger owner.

S4. Frontend grammar/state.

- Replace SSE event decoders.
- Update `useChatRunTail`, `useChatMessageUpdates`, `useConversation`.
- Add live states and UI affordances.
- Verify scroll and markdown performance.

S5. Verification and negative gates.

- Add direct chat tail tests.
- Add real DB/HTTP stream integration test.
- Add browser/E2E reconnect/cancel/reload tests.
- Add the protected Codex/MCP streaming tool smoke.
- Add grep gates.

S6. Docs.

- Update `docs/modules/llms.md`, `docs/modules/chat.md`, and
  `docs/architecture.md`.
- Mark this spec implemented with any post-implementation corrections.

All slices land as one hard cutover branch for merge. Intermediate commits may
be reviewable, but main must never contain a dual public stream contract.

---

## 17. Test Plan

### 17.1 Generation seam

- A protocol-valid UDS peer proves contiguous v2 frames, terminal-last,
  per-capability bounds, and strict rejection of gaps/unknown frames.
- Capacity is reschedulable only for the exact pre-accept 503 contract.
- Accepted loss without terminal remains `Uncertain` and dispatches no second
  generation.
- Cancel invokes the private endpoint and consumes the same turn's cancelled
  terminal when available.

### 17.2 Nexus backend

- Schema rejects old event names.
- Coalescer flushes on interval, cap, tool event, terminal, cancel, exception.
- Chat execution maps generation frames into durable chat events.
- `GET /chat-runs/{id}` materializes pending text and cursor from event rows.
- Reconnect path starts after folded cursor.
- Cancel route finalizes with `E_CANCELLED`.
- Accepted stream loss preserves partial text without fabricating a terminal.
- LISTEN/NOTIFY integration delivers events inserted after stream open.
- `llm_calls` retains only the unified fixed-plan terminal/usage audit.

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
- Codex/MCP fixture stream emits tool-call input deltas and final tool
  result.
- Citation chips survive terminal reconcile.

### 17.5 Protected route smoke

The enrolled-host smoke proves the Codex Personal route through the same v2 UDS
client. Provider certification separately proves each Chat-eligible API route.
One Chat case additionally proves incremental text, route-neutral tool use and
continuation, cancellation, and redacted ledger facts.

---

## 18. Risks And Mitigations

R1. Coalescing makes text feel less immediate.

Mitigation: 33ms default interval, flush on first text immediately, frontend
RAF batching. Acceptance checks first-visible text and flush cadence.

R2. Pending snapshot folding is expensive for very long runs.

Mitigation: one-user prototype accepts folding from event rows. If measured
expensive later, add a server-owned materialized cursor/snapshot table in a
separate design, not a frontend heuristic.

R3. Cancellation watcher adds polling.

Mitigation: prefer DB notification or worker-local signal; if bounded polling
is used, add `justify-polling` and named timing constants.

R4. Tool-call partial input could leak sensitive arguments.

Mitigation: render only the strict durable event's safe parsed projection. Never
render raw partial JSON if the tool is not allowlisted for safe display.

R5. Old dev DB event rows fail parsing.

Mitigation: migration deletes or normalizes old chat event rows for non-terminal
local data. Production acceptance targets current app state, not legacy dev
history.

---

## 19. Rejected Alternatives

### WebSockets

Rejected. Bidirectional transport does not solve generation-frame semantics,
durable replay, cancellation, or UI folding. SSE already matches persisted
append-only event delivery.

### Adopt AI SDK end to end

Rejected as a substrate. AI SDK is a useful reference for typed data streams and
tool-call streaming UI, but Nexus needs Python/FastAPI, the private Codex and
configured API route boundaries, durable ChatRun, citations, and resource graph composition. A
wholesale adoption would move ownership to the wrong layer.

### Client-only smoothing

Rejected. RAF batching is necessary but not sufficient. Backend write cadence
and replay cursor semantics are owner-layer concerns.

### Snapshot-only pending text on reconnect

Rejected. Snapshot is used for reconcile, but SSE must continue from a durable
event cursor so live state, tool events, and terminal events are not lost.

### Native conversation ids

Rejected as default. Native continuation state would weaken Nexus-owned prompt,
tool, ledger, and replay authority; each generation opens one native turn.

---

## 20. Done Means

- Nexus chat consumes only the private v2 `GenerationFrame` contract and maps it
  through bounded coalescing.
- All chat UIs share the same stream engine and live state.
- Reconnect is cursor-based and deterministic.
- Stop cancels the Codex generation, not just the local stream.
- Protected Codex/MCP evidence proves streaming tool calls and continuation.
- Old event names, direct-provider stream contracts, and replay heuristics are
  gone.
- Docs and negative gates pin the final state.
