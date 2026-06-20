# Chat Subsystem Consolidation Hard Cutover

Status: SPEC - Rev 1
Author altitude: SME / staff
Date: 2026-06-19
Type: hard cutover - no legacy paths, no fallbacks, no backward compatibility,
no re-export shims, no dual owners. Where old scattered logic and a new single
owner both exist, only the new owner survives.

This is the "simplify and consolidate the chat mess" spec. It owns **structural
ownership and duplication collapse** in the chat subsystem. It is orthogonal to,
and composes with, three sibling specs that own other axes of chat:

Composes with (does not duplicate, does not supersede):

- `docs/cutovers/sota-chat-streaming-hard-cutover.md` — owns the streaming
  **transport**: provider stream protocol, the chat event **grammar**, text
  coalescing, cursor replay, cancellation. This spec gives that cutover small,
  single-owner files to modify instead of a 2,700-line god file.
- `docs/cutovers/resource-chat-subject-hard-cutover.md` — owns **surface**
  consolidation (one `ResourceRef` chat subject; deletes `DocChatTab`,
  `ReaderChatDetail`, per-pane `/conversations` POSTs).
- `docs/cutovers/chat-scroll-anchoring-hard-cutover.md` — owns transcript
  **scroll anchoring** behavior.

Supersedes: the structural assumptions in the retired
`docs/cutovers/codebase-cleanliness-audit.md` for the chat subsystem only.

Does not supersede the chat module contract (`docs/modules/chat.md`); it makes
that contract true by collapsing the duplication that violates it.

---

## 0. North Star

The chat subsystem keeps its current architecture and behavior exactly, but each
concern has exactly one owner. No message-list mutation lives in three hooks; no
citation logic lives inside the run executor; no run-tail query is copy-pasted
across chat, oracle, and library-intelligence. After the cutover a reader can
name the single file that owns message transitions, citation persistence, tool
dispatch, run-event emission, per-run stream lifecycle, and run-visibility — and
the cross-run/stream machinery shared with oracle/LI/media lives in `run_kit`,
not forked per surface.

**Target behavior: zero behavior change.** Same UX, same HTTP/SSE contract, same
DB rows. This is a pure ownership and duplication cutover. Its proof is that the
existing chat test suites pass unchanged in behavior while the negative gates
that forbid the old scattered patterns turn green.

---

## 1. SME Thesis

"Chat is a mess" is not an architecture failure — the engine/view/adapter split,
the durable `ChatRun`, citations-as-edges, and the shared `/stream/*` plane are
sound. It is an **ownership** failure: the right concepts exist but are smeared
across god files and duplicated hooks.

The professional move is not a rewrite and not new abstraction layers. It is to:

1. **Collapse the message-list to one update owner.** Today three hooks call
   `setMessages` from 17 sites. A single pure reducer makes every transition one
   named action with one consumer.
2. **Extract the cohesive services hiding inside `chat_runs.py`.** Citation
   building, tool dispatch, and run-event emission are each a service wearing a
   god file as a costume. Extract them so the executor is an executor.
3. **Generalize the run/stream machinery that is already triplicated** across
   chat/oracle/LI into `run_kit`, which already owns `append_event`,
   `mark_terminal`, and `RunStreamKind`. `get_*_events` and `is_*_terminal` are
   the same query three times.
4. **Unify the per-run lifecycle state** (abort handle, supersession token,
   first-delta latch) into one per-run context, and the **five run-visibility
   predicates** into one factory.
5. **Resist over-refactoring.** `conversations.py` and `context_assembler.py`
   are large but cohesive; splitting them would thread mutable state through new
   seams for no ownership gain. Leave them. Cutover discipline includes knowing
   what not to touch.

The one-user prototype constraint changes scale, not correctness: the same
single-owner contracts a larger system would keep, minus speculative layers.

---

## 2. Current Head Facts

### 2.1 Sound architecture to keep

- FE engine/view/adapter split (`useConversation` / `ChatSurface` /
  `Conversation` + `ResourceChatDetail`), per `docs/modules/chat.md`.
- BE durable `ChatRun` executed by a worker, tailed over `/stream/*`; `run_kit`
  owns event append + terminal; `llm_ledger` is the flight recorder.
- Citations are `resource_edges`; `message_retrievals` is telemetry; the trust
  trail is a read model.

### 2.2 The duplication inventory this spec owns (verified, with `file:line`)

Frontend (`apps/web/src`):

- **Message-list has three mutation owners, 17 `setMessages` sites.**
  `useConversation.ts` (`:324,469,542,584,660,737,775`),
  `useChatMessageUpdates.ts` (`:155,176,188,226,275,340,386,415,460`),
  `useChatRunTail.ts` (`:155`). No single transition owner.
- **Per-run stream tracking is split across three structures** in
  `useChatRunTail.ts`: `activeStreamsRef` (`:95`), `runTokensRef` (`:96`),
  `firstDeltaRunIdsRef` (`:97`), plus a closure `streamAbort` — read/written at
  ~23 sites.
- **Five run-visibility predicates**: `shouldApplyRun` / `shouldStartRun`
  (`useConversation.ts:219-241`) and closures `runIsVisible` /
  `currentRunIsVisible` / `runCanStart` (`useChatRunTail.ts:213-236`), gating
  ~22 call sites.
- **Dead code**: `handleOptimisticMessages` (`useChatMessageUpdates.ts:174-179`)
  is defined and exported but never called.
- **Prop-explosion**: `ChatComposer` ~20 props (`:37-106`), `ChatSurface` 13
  props (`:23-41`) — violates the single-object boundary-API rule.

Backend (`python/nexus`):

- **`chat_runs.py` is ~2,719 lines** and contains three cohesive services:
  - Citation family (~754 LOC, 10 fns): `_record_tool_citations` (`:277`),
    `_record_retrieval_citation` (`:332`), `_citation_target_ref` (`:388`),
    `_persist_attached_citations` (`:473`), `prune_tool_call_retrievals`
    (`:538`), `_delete_citation_edge` (`:619`), `_clear_message_citations`
    (`:637`), `_persist_read_evidence_citation` (`:657`),
    `_emit_citation_index` (`:974`).
  - Tool dispatch/output (~289 LOC): `_app_search_tool_output` (`:425`),
    `_web_search_tool_output` (`:450`), `_persist_tool_call_start` (`:697`),
    `_persist_tool_call_error` (`:794`), `_bind_provider_tool_call_events`
    (`:809`), `_tool_start_event` (`:835`), `_persist_tool_call_trace` (`:858`),
    `_tool_trace_event` (`:953`).
  - Run-event emission (~40 sites): mixed `append_and_commit` vs
    `append_run_event` at `:1065,1091,1257,1419,1783,1915,1946,1970,1988,2197,
    2235,2277-2546`, with hand-rolled `db.commit()` interleaved.

Cross-subsystem (chat vs oracle vs LI):

- **`get_*_events` is the same query three times**: `get_chat_run_events`
  (`chat_runs.py:1501`), `get_reading_events` (`oracle.py:515`),
  `get_revision_events` (`library_intelligence_revisions.py:235`).
- **`is_*_terminal` is the same query three times**: `is_chat_run_terminal`
  (`chat_runs.py:1529`), `is_reading_terminal` (`oracle.py:536`),
  `is_revision_terminal` (`library_intelligence_revisions.py:260`).
- **FE SSE decoders duplicate guard utilities**: `sse/events.ts`
  (`toChatSSEEvent`) and `sse/libraryIntelligenceEvents.ts` (`toLISSEEvent`,
  comment: "Mirrors toChatSSEEvent") share `sse/guards.ts` predicates but
  re-implement the dispatch shell.

### 2.3 Already-shared primitives (must NOT be re-forked)

`run_kit` (`RunStreamKind`, `append_event`, `mark_terminal`, `notify_channel`,
`terminal_statuses`), `llm_ledger.observed_generate_stream` / `LlmCallOwner`,
the `/stream` plane (`_sse.tail_cursor_stream`, `stream.py` kind factories,
`make_cursor_stream_response`), the citation read-model
(`resource_graph.citations.record_citation` / `build_citation_outs`), and the FE
generic stream client (`sseClientDirect`, `openGenerationRunStream`,
`useGenerationRun`). These are correct single owners. The cutover extends them
(`get_run_events`, `is_run_terminal`); it does not duplicate them.

---

## 3. Hard-Cutover Posture

- One owner per concern after the cutover. The old scattered functions are
  **deleted**, not re-exported. `chat_runs.py` imports the new services; it does
  not keep private copies.
- No behavior change is the contract. If a test must change beyond an import
  path or a call shape, that is a regression, not a refactor.
- No new abstraction layer. The new modules are *extractions of existing logic*,
  not a `ChatManager`/`ChatController` framework.
- No partial dedup left behind. If `get_run_events` is generalized to `run_kit`,
  all three surfaces use it; none keeps a private query.

---

## 4. Goals

G1. One message-update owner — a pure reducer; one `setMessages` consumer.

G2. One per-run stream context — abort handle, supersession token, first-delta
latch unified per run.

G3. One run-visibility predicate factory replacing five predicates.

G4. `chat_runs.py` is an executor: provider-stream iteration, tool invocation,
finalization. Citation, tool-dispatch, and event-emission concerns are owned by
dedicated `chat_run_*` services.

G5. `run_kit` owns the run-tail query and terminal check for all run kinds;
chat/oracle/LI stop forking them.

G6. Dead code removed; boundary components take grouped option objects.

G7. The chat test suites prove unchanged behavior; new negative gates forbid the
old patterns.

---

## 5. Non-Goals

N1. No streaming-transport change (provider protocol, event grammar, coalescing,
cursor replay, cancellation) — owned by `sota-chat-streaming-hard-cutover.md`.

N2. No surface/subject change (`DocChatTab`, `ReaderChatDetail`, resource subject
contract) — owned by `resource-chat-subject-hard-cutover.md`.

N3. No scroll-behavior change — owned by `chat-scroll-anchoring-hard-cutover.md`.

N4. No split of `conversations.py` or `context_assembler.py` (see §14). They are
cohesive; splitting them threads mutable state for no ownership gain.

N5. No generalization of chat-local concerns (branch visibility, active-path,
optimistic messages, multi-run reconciliation, trust trail) into shared
primitives — they have no oracle/LI/media equivalent (see §14).

N6. No new product API, schema, or UX. Internal restructuring only.

N7. No global state library (Zustand/Redux). The reducer is a pure function; the
engine remains hook-owned.

---

## 6. Scope

In scope:

- FE: a message-update reducer; a per-run stream context; a run-visibility
  factory; dead-code removal; boundary prop grouping; shared SSE guard utilities.
- BE: extract `chat_run_citations.py`, `chat_run_tools.py`, and a typed
  run-event emitter (in `chat_run_event_store.py`) out of `chat_runs.py`;
  generalize `run_kit.get_run_events` / `run_kit.is_run_terminal` and repoint
  chat/oracle/LI.
- Docs + grep negative gates.

Out of scope:

- Everything owned by the three sibling specs (§5 N1–N3).
- Oracle/LI/media internals beyond repointing them at the generalized `run_kit`
  query/terminal helpers.
- Android shell, deployment.

Boundary with `sota-chat-streaming` (both touch `chat_runs.py`): this spec
extracts the run-event **emitter** with the **current** grammar as the single
typed append owner. The streaming cutover then reshapes payloads **inside that
one owner**, converting a 40-site grammar churn into a one-owner change. Land
this consolidation first; it de-risks the streaming cutover.

---

## 7. Final Architecture

### 7.1 Frontend ownership map

```text
useConversation (engine)
  owns: conversationId, title, messages (state), olderCursor, loading/error,
        branch state (forkOptionsByParentId, pathCacheByLeafId, branchGraph,
        activeLeafMessageId, branchDraft), lifecycle dispatch
  delegates ALL message transitions to ->

messageUpdateReducer (NEW, pure, lib/conversations/messageUpdateReducer.ts)
  the ONLY function that returns the next messages[] for every transition:
  set_all | prepend_older | seed_optimistic | swap_meta_ids | fold_text_delta |
  apply_tool_call | apply_tool_result | apply_citation_index |
  apply_context_ref | finalize_done | merge_run_pair

useChatRunTail (orchestration seam — stays; chat-local per §14)
  owns: which runs to tail, reconnect/reconcile, multi-run lifecycle
  per-run state via ->

PerRunStreamContext (NEW, components/chat) : Map<runId, {
    token: number; abort: AbortController; firstDeltaSeen: boolean }>
  replaces activeStreamsRef + runTokensRef + firstDeltaRunIdsRef + closure abort

runVisibility (NEW, pure, lib/conversations/runVisibility.ts)
  createRunVisibility({ shouldStart, shouldApply, isMounted }) ->
    { canStart(ctx), isVisible(ctx) }
  replaces shouldApplyRun + shouldStartRun + runIsVisible +
  currentRunIsVisible + runCanStart

useChatMessageUpdates (stays as the fold layer; dispatches reducer actions)
useChatDraft / useChatModels / useConversationContextRefs (unchanged; §14)
```

The cursor/`folded_event_seq` semantics stay owned by
`sota-chat-streaming-hard-cutover.md`. `PerRunStreamContext` unifies abort +
token + first-delta only; it does not absorb the replay cursor.

### 7.2 Backend ownership map

```text
chat_runs.py (executor; ~2,119 LOC target)
  owns: _execute_chat_run loop, provider-stream iteration, tool-loop control,
        finalization. Calls the services below.

chat_run_citations.py (NEW; the 10-fn citation family)
  owns: selected-retrieval -> citation edge (ordinal), attached citations,
        prune (rows + edges, cascade), read-evidence citation, citation_index.
  uses: resource_graph.citations.record_citation, message_retrievals telemetry.

chat_run_tools.py (NEW; tool dispatch + output)
  owns: message_tool_calls lifecycle (start/delta/done/error), tool-output
        rendering (app_search/web_search), provider tool-event binding,
        read/inspect trace rows.

chat_run_event_store.py (EXTENDED into the single run-event emitter)
  owns: every durable chat run-event append. Typed methods replace the ~40
        inline append_and_commit / append_run_event sites. One commit policy.
  (sota-chat-streaming reshapes payloads HERE, one owner, not 40 sites.)

run_kit.py (EXTENDED, cross-subsystem)
  + get_run_events(db, kind, parent_id, after) -> (events, terminal)
  + is_run_terminal(db, kind, parent_id) -> bool
  chat/oracle/LI delete their private get_*_events / is_*_terminal and call these.
```

### 7.3 Cross-subsystem generalization

`run_kit` already owns `RunStreamKind`, `append_event`, `mark_terminal`,
`notify_channel`, `terminal_statuses`. It gains the two queries that are
currently triplicated. The `/stream/*` route factories
(`stream.py` `CursorStreamKind`) already dispatch by kind; they call
`run_kit.get_run_events` instead of per-surface functions, and the per-surface
ownership `assert_viewer` callbacks stay where viewer scoping differs (chat
checks conversation ownership; oracle/LI check their own owner).

FE: `sse/guards.ts` becomes the shared guard-utility owner for both
`toChatSSEEvent` and `toLISSEEvent`. The **dispatchers stay separate** — chat's
event grammar is locked by the streaming cutover and may diverge from LI's; only
the `hasOnlyKeys` / `isOptionalString`-style predicates are shared.

---

## 8. Duplicate Patterns To Consolidate

The core deliverable. Each row: pattern → current sites → final single owner.

| # | Pattern | Current `file:line` | Final owner | Est. Δ |
|---|---|---|---|---|
| F1 | Message-list mutation across 3 hooks (17 `setMessages`) | `useConversation.ts:324,469,542,584,660,737,775`; `useChatMessageUpdates.ts:155,176,188,226,275,340,386,415,460`; `useChatRunTail.ts:155` | `messageUpdateReducer.ts` (pure) + 1 consumer | ~−150 |
| F2 | Per-run stream tracking split 3 ways | `useChatRunTail.ts:95,96,97` + closure abort, ~23 sites | `PerRunStreamContext` (one map) | ~−30 |
| F3 | Five run-visibility predicates | `useConversation.ts:219-241`; `useChatRunTail.ts:213-236` (+~22 calls) | `runVisibility.ts` factory | ~−10 |
| F4 | Dead `handleOptimisticMessages` | `useChatMessageUpdates.ts:174-179` | delete (folds into F1 `seed_optimistic`) | −6 |
| F5 | Boundary prop-explosion | `ChatComposer.tsx:37-106` (~20); `ChatSurface.tsx:23-41` (13) | grouped option objects | ~−18 net |
| B1 | Citation family (10 fns, ~754 LOC) | `chat_runs.py:277,332,388,473,538,619,637,657,974` | `chat_run_citations.py` | −200 in chat_runs |
| B2 | Tool dispatch + output (~289 LOC) | `chat_runs.py:425,450,697,794,809,835,858,953` | `chat_run_tools.py` | −150 in chat_runs |
| B3 | Run-event emission (~40 sites, mixed commit policy) | `chat_runs.py:1065,1091,1257,1419,1783,1915,1946,1970,1988,2197,2235,2277-2546` | typed emitter in `chat_run_event_store.py` | −250 in chat_runs |
| X1 | `get_*_events` (same query ×3) | `chat_runs.py:1501`; `oracle.py:515`; `library_intelligence_revisions.py:235` | `run_kit.get_run_events(kind,parent_id,after)` | 3→1 |
| X2 | `is_*_terminal` (same query ×3) | `chat_runs.py:1529`; `oracle.py:536`; `library_intelligence_revisions.py:260` | `run_kit.is_run_terminal(kind,parent_id)` | 3→1 |
| X3 | FE SSE guard utilities re-implemented | `sse/events.ts`; `sse/libraryIntelligenceEvents.ts`; `sse/guards.ts` | shared `sse/guards.ts` (utils only; not dispatchers) | dedup utils |

Target: `chat_runs.py` ~2,719 → ~2,119 LOC; FE ~−215 LOC net; three triplicated
backend queries collapsed to one each.

---

## 9. Capability Contract

The new/extended owners and their guarantees.

- **`messageUpdateReducer(state, action) -> ConversationMessage[]`** — pure,
  total over a tagged `MessageUpdateAction` union, no I/O, no refs. Exhaustive
  `switch` (an unknown action is a compile error). The single place message
  identity, ordering, and per-field updates change.
- **`PerRunStreamContext`** — one record per in-flight run: `{ token, abort,
  firstDeltaSeen }`. Owns supersession (token bump on abort-all), cancellation
  (one `AbortController`), and the first-delta latch. Does **not** own the replay
  cursor (streaming cutover owns `folded_event_seq`).
- **`createRunVisibility({ shouldStart, shouldApply, isMounted })`** — returns
  `{ canStart(ctx), isVisible(ctx) }`. The only gate for "does this run's event
  apply to the current view". Pure given its inputs.
- **`chat_run_citations`** — sole owner of chat citation persistence: selected
  retrieval → `resource_edges` citation (ordinal), `message_retrievals`
  telemetry linkage (`cited_edge_id`), prune (rows + edges, cascade-safe), and
  the `citation_index` event payload. Invariant: no orphaned edge or retrieval.
- **`chat_run_tools`** — sole owner of `message_tool_calls` lifecycle and tool
  output rendering/binding. Invariant: every emitted tool event is bound to its
  persisted `tool_call_id`.
- **`chat_run_event_store` emitter** — sole owner of durable run-event append for
  chat. One commit policy; typed per-event methods; no caller hand-rolls
  `append_and_commit` + `db.commit()`.
- **`run_kit.get_run_events` / `run_kit.is_run_terminal`** — kind-dispatched run
  tail query + terminal check for chat/oracle/LI. Viewer scoping stays in the
  SSE route's `assert_viewer`, not in the query.

---

## 10. API Design

```ts
// apps/web/src/lib/conversations/messageUpdateReducer.ts
export type MessageUpdateAction =
  | { type: "set_all"; messages: ConversationMessage[] }
  | { type: "prepend_older"; messages: ConversationMessage[] }
  | { type: "seed_optimistic"; user: ConversationMessage; assistant: ConversationMessage }
  | { type: "swap_meta_ids"; map: ReadonlyArray<{ tempId: string; realId: string }> }
  | { type: "fold_text_delta"; assistantId: string; delta: string }
  | { type: "apply_tool_call"; assistantId: string; call: ToolCallPatch }
  | { type: "apply_tool_result"; assistantId: string; result: ToolResultPatch }
  | { type: "apply_citation_index"; assistantId: string; citations: ReaderCitationData[] }
  | { type: "apply_context_ref"; assistantId: string; ref: ContextRefPatch }
  | { type: "finalize_done"; assistantId: string; status: AssistantStatus; errorCode: string | null }
  | { type: "merge_run_pair"; run: ChatRunData; idsToReplace: readonly string[] };

export function messageUpdateReducer(
  state: ConversationMessage[],
  action: MessageUpdateAction,
): ConversationMessage[];
```

```ts
// apps/web/src/lib/conversations/runVisibility.ts
export interface RunVisibilityContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
}
export function createRunVisibility(opts: {
  shouldStart: (ctx: RunVisibilityContext) => boolean;
  shouldApply: (ctx: RunVisibilityContext) => boolean;
  isMounted: () => boolean;
}): { canStart: (ctx: RunVisibilityContext) => boolean; isVisible: (ctx: RunVisibilityContext) => boolean };
```

```python
# python/nexus/services/run_kit.py
def get_run_events(
    db: Session, kind: RunStreamKind, parent_id: UUID, after: int
) -> tuple[list[RunEventOut], bool]: ...   # (events, terminal)

def is_run_terminal(db: Session, kind: RunStreamKind, parent_id: UUID) -> bool: ...
```

```python
# python/nexus/services/chat_run_event_store.py  (the emitter)
class ChatRunEventEmitter:
    def __init__(self, db: Session, run_id: UUID) -> None: ...
    def text_delta(self, assistant_message_id: UUID, text: str) -> None: ...
    def activity(self, assistant_message_id: UUID, phase: ActivityPhase) -> None: ...
    def tool_call_start(self, ...) -> None: ...
    def tool_result(self, ...) -> None: ...
    def citation_index(self, assistant_message_id: UUID, payload: CitationIndexPayload) -> None: ...
    def context_ref_added(self, ...) -> None: ...
    # one commit policy; terminal `done` stays via run_kit.mark_terminal
```

(The emitter's payload shapes are the **current** grammar; the streaming cutover
edits them here, in one place.)

---

## 11. Files To Change

New:

- `apps/web/src/lib/conversations/messageUpdateReducer.ts` (+ `.test.ts`, node unit).
- `apps/web/src/lib/conversations/runVisibility.ts` (+ `.test.ts`, node unit).
- `python/nexus/services/chat_run_citations.py` (+ tests).
- `python/nexus/services/chat_run_tools.py` (+ tests).

Changed (FE):

- `useConversation.ts` — dispatch reducer actions; drop raw `setMessages` bodies;
  hold the `messages` state + branch state only.
- `useChatMessageUpdates.ts` — return/dispatch reducer actions; delete
  `handleOptimisticMessages`; keep `deltaBufferRef` as a private RAF detail.
- `useChatRunTail.ts` — `PerRunStreamContext` map; `createRunVisibility`; merge
  via reducer `merge_run_pair`.
- `ChatComposer.tsx`, `ChatSurface.tsx` — grouped option-object props; update the
  `Conversation.tsx` call sites.
- `apps/web/src/lib/api/sse/guards.ts` — become the shared guard-util owner;
  `sse/events.ts` and `sse/libraryIntelligenceEvents.ts` import from it.

Changed (BE):

- `chat_runs.py` — delete the extracted citation/tool/emit bodies; call the new
  services; shrink `_execute_chat_run` to the loop.
- `chat_run_event_store.py` — host the `ChatRunEventEmitter`.
- `run_kit.py` — add `get_run_events` / `is_run_terminal`.
- `oracle.py`, `library_intelligence_revisions.py` — delete private
  `get_*_events` / `is_*_terminal`; call `run_kit`.
- `api/routes/stream.py` — `CursorStreamKind` read-after calls `run_kit.get_run_events`.

Tests/docs:

- `python/tests/test_chat_runs.py`, `test_chat_run_citations.py` (new),
  `test_chat_run_tools.py` (new), `test_run_kit.py`, `test_oracle.py`,
  `test_library_intelligence*.py`.
- `apps/web/.../messageUpdateReducer.test.ts`, `runVisibility.test.ts`,
  `useChatRunTail.test.tsx`, `useConversation.test.tsx`, `ChatComposer.test.tsx`.
- `docs/modules/chat.md` (service boundaries), this spec, negative gates.

---

## 12. Composition With Existing Systems

- **`sota-chat-streaming`**: this spec gives it small owned files. The event
  emitter, `chat_run_tools`, and `chat_run_citations` are the homes the streaming
  cutover edits. The FE `PerRunStreamContext` is disjoint from the streaming
  cursor. Sequence: consolidation first.
- **`resource-chat-subject`**: disjoint (surfaces). The reducer's `merge_run_pair`
  and `seed_optimistic` are unaffected by which subject a run carries.
- **`chat-scroll-anchoring`**: disjoint (scroll). The reducer keeps message
  identity stable, which aids the scroll cutover's row-memoization (AC-7 there).
- **Oracle / LI / Media**: gain `run_kit.get_run_events` / `is_run_terminal`;
  lose their private copies. Their event **grammars** stay their own.
- **`run_kit` / `llm_ledger` / `/stream` plane / citation read-model**: extended,
  never re-forked (§2.3).

---

## 13. Key Decisions

1. **A pure reducer, not a store.** Message transitions become one total
   function; the engine stays hook-owned. No Zustand/Redux (repo doctrine).
2. **Extract services with the current contracts; let the streaming cutover
   reshape payloads inside them.** One owner to change later beats 40 sites.
3. **Generalize the run-tail query/terminal into `run_kit`, keep viewer scoping
   in the route.** The query is identical; only ownership assertion differs.
4. **One per-run context object, not three refs.** Abort + token + first-delta
   are one lifecycle.
5. **One visibility factory, not five predicates.** Start vs apply vs mounted are
   facets of one decision.
6. **Do not split `conversations.py` / `context_assembler.py`.** Cohesive;
   splitting threads mutable budget/visibility state for no ownership gain (§14).
7. **Share SSE guard utilities, not dispatchers.** Chat's grammar is locked by
   the streaming cutover and may diverge from LI's.
8. **Zero behavior change is the acceptance bar.** This is ownership, not
   features.

---

## 14. What Stays As-Is (anti-over-refactor)

Explicitly **not** changed, with reason:

- **`conversations.py` (`message_to_out` `:219`, visibility CTE `:354`, cursor
  codec `:80-122`)** — `message_to_out` is a domain read-model (trust trail +
  citations), correctly single-owned; the cursor codec is already centralized.
  Splitting adds seams without removing duplication.
- **`context_assembler.py` phases (`:111-350` + helpers)** — budget, history,
  retrieval, resource resolution, token estimation share a mutable budget and
  the `ContextAssembly` struct. Document the phases; do not extract them.
- **`_parse_last_event_id` / `_parse_sse_attempt` (`stream.py:214-237`)** —
  already single owners; only the 3-element CORS header list is mildly
  duplicated (`stream_cors.py:55`) and is left as low-ROI.
- **`useChatDraft`, `useChatModels`, `useConversationContextRefs`** — correct
  independent scopes (per-target draft, module model cache, resource list).
- **Chat-local concerns — do not generalize**: branch visibility +
  `conversation_branches.py`, active-path filtering, optimistic messages,
  multi-run reconciliation (`useChatRunTail`), and the trust-trail read model.
  Verified to have no oracle/LI/media equivalent;
  `sota-chat-streaming-hard-cutover.md` §13.9 pins `useChatRunTail` as the
  chat-only orchestration seam.

---

## 15. Acceptance Criteria

AC-1 One message owner. Exactly one `setMessages` consumer exists; every
transition is a `messageUpdateReducer` action. Reducer unit tests cover each
action; existing transcript behavior is unchanged.

AC-2 One per-run context. `activeStreamsRef` / `runTokensRef` /
`firstDeltaRunIdsRef` are gone; one `PerRunStreamContext` map remains. Multi-run
supersession/abort behavior is unchanged.

AC-3 One visibility owner. The five predicates are replaced by
`createRunVisibility`; branch/active-path gating behavior is unchanged.

AC-4 Executor shrinks. `chat_runs.py` no longer defines citation, tool-dispatch,
or raw event-append functions; it imports `chat_run_citations`,
`chat_run_tools`, and the `ChatRunEventEmitter`. Target ≤ ~2,150 LOC.

AC-5 Citation/tool isolation. `chat_run_citations` owns all citation persistence
with no orphaned edges/rows under test; `chat_run_tools` owns the
`message_tool_calls` lifecycle with bound events.

AC-6 One emitter. No `append_and_commit` / `append_run_event` call exists outside
the emitter; one commit policy; payloads are the current grammar.

AC-7 `run_kit` generalization. `oracle.py` / `library_intelligence_revisions.py`
have no private `get_*_events` / `is_*_terminal`; all three call `run_kit`.
Oracle/LI/chat streaming behavior is unchanged.

AC-8 Dead code gone; props grouped. `handleOptimisticMessages` is deleted;
`ChatComposer` / `ChatSurface` take grouped option objects.

AC-9 Behavior parity. Full chat/oracle/LI test suites pass with only import/call
shape changes; no HTTP/SSE/DB contract change; E2E conversations specs pass.

---

## 16. Negative Gates

- No more than one `setMessages(` consumer in `apps/web/src/components/chat` and
  `apps/web/src/lib/conversations` (the reducer-backed engine).
- No `activeStreamsRef` / `runTokensRef` / `firstDeltaRunIdsRef` identifiers.
- No `handleOptimisticMessages` symbol.
- No `_record_*citation`, `_persist_*citation`, `_emit_citation_index`,
  `prune_tool_call_retrievals`, `_app_search_tool_output`,
  `_web_search_tool_output`, `_bind_provider_tool_call_events`,
  `_persist_tool_call_*` defined in `chat_runs.py` (they live in the new
  services).
- No `append_and_commit` / `run_kit.append_event` called directly from
  `chat_runs.py` (only via the emitter).
- No `get_reading_events` / `get_revision_events` / `is_reading_terminal` /
  `is_revision_terminal` in `oracle.py` / `library_intelligence_revisions.py`.

Must remain:

- `run_kit`, `llm_ledger`, `_sse` tailers, `stream.py` kind factories, the
  citation read-model, `sseClientDirect`, `openGenerationRunStream`,
  `useChatRunTail` as the chat orchestration seam, citations-as-edges.
- `conversations.py` / `context_assembler.py` structure (§14).

---

## 17. Implementation Sequence

All slices land as one hard-cutover branch; main never holds a dual owner.

S0. Reducer + factories (FE), pure, behind tests.
- Add `messageUpdateReducer` + tests; add `runVisibility` + tests.

S1. Wire FE.
- `useConversation` / `useChatMessageUpdates` / `useChatRunTail` dispatch the
  reducer; introduce `PerRunStreamContext`; delete `handleOptimisticMessages`.

S2. FE boundary cleanup.
- Group `ChatComposer` / `ChatSurface` props; share `sse/guards.ts`.

S3. BE service extraction.
- `chat_run_citations.py` and `chat_run_tools.py`; repoint `chat_runs.py`;
  delete the extracted bodies.

S4. BE emitter.
- `ChatRunEventEmitter` in `chat_run_event_store.py`; replace all ~40 append
  sites; one commit policy.

S5. `run_kit` generalization.
- Add `get_run_events` / `is_run_terminal`; repoint chat/oracle/LI and
  `stream.py`; delete the private copies.

S6. Verify + gates.
- Run chat/oracle/LI suites (behavior parity), add the new unit/service tests,
  add grep negative gates.

S7. Docs.
- Update `docs/modules/chat.md` service boundaries; mark this spec built.

---

## 18. Test Plan

- `messageUpdateReducer.test.ts` (node): one case per action; idempotent
  duplicate-seq fold; meta-id swap; finalize.
- `runVisibility.test.ts` (node): start/apply/mounted matrix.
- `useChatRunTail.test.tsx` / `useConversation.test.tsx` (browser): unchanged
  multi-run, supersession, reconnect behavior through the new context/reducer.
- `test_chat_run_citations.py`: ordinal assignment, prune cascade (no orphans),
  attached-citation idempotency, `citation_index`.
- `test_chat_run_tools.py`: tool-call start/delta/done/error, event binding,
  read/inspect trace.
- `test_run_kit.py` + `test_oracle.py` + `test_library_intelligence*.py`:
  `get_run_events` / `is_run_terminal` parity for all three kinds.
- Existing `test_chat_runs.py`, `test_sse.py`, `test_stream_listen.py`,
  `e2e/tests/conversations.spec.ts`: behavior parity.

---

## 19. Risks And Mitigations

R1. Extraction silently changes commit ordering (events/citations).
Mitigation: the emitter owns one commit policy; service tests assert row/edge
counts and ordering; behavior-parity suites gate.

R2. Reducer subtly reorders or drops a transition.
Mitigation: exhaustive action union (compile-time totality); one case per action
test; the browser suites replay real run sequences.

R3. `run_kit` generalization leaks viewer scoping.
Mitigation: viewer assertion stays in the SSE route `assert_viewer`; the query
takes `parent_id` only; oracle/LI parity tests.

R4. Overlap churn with the streaming cutover on `chat_runs.py`.
Mitigation: land consolidation first; the streaming cutover then edits the
single emitter/service owners, not the executor body.

R5. Scope creep into `conversations.py` / `context_assembler.py`.
Mitigation: §14 is a hard boundary; touching them is out of scope.

---

## 20. Rejected Alternatives

**Global store (Zustand/Redux) for chat state.** Rejected: the reducer gives
single-owner transitions without moving ownership out of the engine hook;
repo doctrine avoids a state library for one user.

**Split `conversations.py` / `context_assembler.py` too.** Rejected: cohesive;
splitting threads mutable budget/visibility/cursor state through new seams for no
duplication removed (§14).

**Generalize chat's run-tail hook / event dispatcher across oracle/LI.**
Rejected: chat's multi-run/branch reconciliation has no oracle/LI equivalent;
only the backend query and FE guard utilities are truly shared.

**Defer extraction and let the streaming cutover carve `chat_runs.py`.**
Rejected: the streaming cutover should modify owned services, not first untangle
a god file under a grammar change. Consolidate first.

**Keep old functions as thin re-export shims.** Rejected: hard cutover — one
owner, no compatibility layer.

---

## 21. Done Means

- One reducer owns message transitions; one per-run context; one visibility
  factory; dead code gone; boundary props grouped.
- `chat_runs.py` is an executor; citations, tools, and event emission are owned
  by `chat_run_*` services with one commit policy.
- `run_kit` owns the run-tail query and terminal check for chat/oracle/LI; no
  private copies remain.
- Behavior, HTTP/SSE, and DB contracts are unchanged; suites prove parity.
- `docs/modules/chat.md` and grep negative gates pin the single-owner state.
