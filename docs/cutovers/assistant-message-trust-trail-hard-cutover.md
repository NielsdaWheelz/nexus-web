# Assistant Message Trust Trail - Persisted Inspector Hard Cutover

Status: IMPLEMENTED - Rev 1
Author altitude: SME / staff
Date: 2026-06-12
Type: hard cutover - no legacy paths, no fallbacks, no backward compatibility, no compat shims

**Superseded by default-library-virtualization-and-transient-state-pruning-hard-cutover.md
(2026-07-17):** `message_retrieval_candidate_ledgers` and
`message_rerank_ledgers` — named throughout this document (including the
trust-trail source-row list, the `trust_trail` field inventory, and the
`TrustAssistantRunOut.candidate_ledgers`/`rerank_ledgers` dataclass fields) —
are dropped tables/fields as of that cutover. Candidate generation and
rerank/selection are now transient, in-memory passes with no durable ledger
row of their own; `message_retrievals` is the sole durable per-result record,
and the persisted `trust_trail` read model no longer has a candidate/rerank
section to assemble. Everything else in this document — the citation-edge
model, the tool-call/prompt-assembly/chat-run inventory, and the streaming
vs. reload contract — is unchanged.

---

## 0. North star

Every assistant message carries one durable, backend-built trust trail that
answers: what prompt budget and context assembled this answer, what model/run
executed it, which tools ran, which retrieval rows and ledgers were produced,
which retrievals became citation edges, which citation edges graduated into
conversation context refs, and what terminal status/error/usage closed the run.

The trust trail is not a verifier and not a second log. It is a typed read model
over the source-of-truth rows the backend already persists:
`chat_prompt_assemblies`, `message_tool_calls`, `message_retrievals`,
`message_retrieval_candidate_ledgers`, `message_rerank_ledgers`,
`resource_edges(origin='citation')`, `chat_run_events(context_ref_added)`, and
`chat_runs`. The frontend renders that read model inside assistant messages.
Streaming mutates the same shape while the run is live; reload returns the same
shape from the API. No trust fact exists only in React state.

---

## 1. SME thesis

The product already records the evidence needed to debug agentic answers, but
the read surface is split:

- live streaming folds `tool_call`, `retrieval_result`, `citation_index`, and
  `context_ref_added` into frontend state;
- message reload rehydrates citation chips from resource edges;
- retrieval telemetry is duplicated into `message_document` retrieval blocks;
- candidate and rerank ledgers live behind separate inspection endpoints;
- prompt assembly exists only as a backend ledger;
- `read_resource` and `inspect_resource` persist traces but do not stream like
  app/web search tools;
- the assistant row only shows active "Searching..." state plus the final answer
  and citation chips.

The professional move is not to make `AssistantMessage.tsx` infer truth from
Markdown, DOM chips, or transient run events. The professional move is a single
assistant-message trust-trail capability with one backend owner, one wire shape,
one frontend model, one UI surface, and one test oracle.

This cutover makes the assistant message itself the inspection boundary. If a
message can be read, its trust trail can be read. If the trust trail is shown
live, the same facts must survive reload.

---

## 2. Hard-cutover posture

- No "temporary inspector" fed only by `message.tool_calls` or
  `message.retrievals`.
- No duplicate primary route where candidate ledgers are still inspected through
  one API and the assistant message shows another partial API.
- No retrieval telemetry in `message_document`; the message document is answer
  content only.
- No frontend reconstruction of citation linkage from rendered `[N]` chips.
- No raw prompt, hidden provider reasoning, API key material, or operator-only
  `llm_calls` payloads in the product UI.
- No compatibility code for old `message_document` retrieval-result blocks after
  the cutover migration.

---

## 3. Duplicate and similar patterns to consolidate

### 3.1 `message_document` retrieval blocks vs retrieval rows

Today `chat_run_message_blocks.py` serializes `message_retrievals` into
`message_document.blocks[type='retrieval_result']` for reload. That duplicates
the real persisted rows and makes the answer document carry telemetry.

Final state: `message_document` contains only text blocks. Retrieval telemetry is
rendered only from `trust_trail.tool_calls[].retrievals[]`.

Delete:

- `MessageDocumentRetrievalResultBlock`
- `MessageDocumentBlock` union arm for `retrieval_result`
- `_retrieval_result_blocks_for_message`
- `message_document_with_run_components` appending telemetry blocks
- frontend code that appends retrieval blocks to `message_document`

### 3.2 Top-level frontend tool/retrieval state vs trust trail

Today `ConversationMessage` has optional `tool_calls` and `retrievals` fields
only the live stream reliably fills. That creates a split between live state and
reload state.

Final state: frontend `ConversationMessage` has one `trust_trail` field for
assistant messages. Active tool activity, completed tool trail, retrieval
summaries, citation linkage, and context-ref-added records all read from it.

Delete top-level frontend `tool_calls` and `retrievals` once all callers move to
`message.trust_trail`.

### 3.3 Standalone ledger inspection routes vs assistant-message read model

Today candidate and rerank ledger APIs exist separately:

- `GET /messages/{message_id}/retrieval-candidate-ledgers`
- `GET /messages/{message_id}/rerank-ledgers`

Final state: the assistant message read model includes candidate and rerank
ledgers under the relevant tool call. Those standalone routes and their Next.js
proxy files are deleted in the same cutover. There is one primary API for the
capability: read an assistant message, get its trust trail.

### 3.4 SSE event shapes vs persisted read shape

Today live events are event-shaped, while reload is message-shaped. The frontend
bridges that difference ad hoc.

Final state: SSE events remain the transport deltas, but `useChatMessageUpdates`
folds them into the same `AssistantTrustTrail` TypeScript shape returned by
`MessageOut`. On `done`, `GET /chat-runs/{id}` reconciles and replaces the live
trail with the backend-built one.

### 3.5 Citation edge linkage split

Today live `citation_index` carries `citation_edge_id`, but persisted
`CitationOut` does not. That is enough for chip rendering, not enough for a trust
trail that joins retrieval row to citation edge.

Final state: `TrustCitationOut` wraps `CitationOut` and includes
`citation_edge_id`. The shared `CitationOut` render contract can stay focused on
chips; the trust trail carries debug linkage.

---

## 4. Goals

G1. Durable assistant-message inspection. Every assistant message returned by
message reads and chat-run reconcile includes its trust trail.

G2. Live/reload parity. A completed message looks the same after stream
completion, page reload, history pagination, branch path load, and retry
replacement.

G3. One owner. A new backend service owns trust-trail assembly. Routes,
frontend components, and tests do not independently join the same rows.

G4. Debuggable agentic future. The contract handles search tools, read/inspect
tools, future tool names, retrieval-bearing and non-retrieval tool calls, prompt
assembly summaries, citation edges, and reference graduations.

G5. Safe disclosure. The UI exposes metadata, statuses, source titles, snippets
already eligible for citation cards, retrieval scores, selected/included flags,
budget summaries, and linkage IDs. It does not expose raw hidden reasoning, raw
API keys, full prompt text, or raw provider payloads.

G6. Consolidation. Remove telemetry duplication from `message_document`, remove
top-level transient frontend tool/retrieval fields, and remove the standalone
ledger APIs.

G7. Typed contracts. Pydantic and TypeScript models are closed, discriminated,
and strict. Unknown transport data is rejected at ingress.

G8. No verifier. The trust trail explains provenance and execution. It does not
judge answer truth or create claim/support state.

---

## 5. Non-goals

N1. No post-hoc factual verifier, support-status classifier, or answer grader.

N2. No raw prompt transcript UI. Prompt assembly is summarized through budgets,
manifest entries, included IDs, dropped items, and safe context references.

N3. No hidden provider reasoning disclosure. Provider reasoning artifacts stay
provider-runtime continuity data, never product data.

N4. No generic observability platform. This cutover builds the product read
model. OTel/export/vendor traces can be added later from the same persisted
source rows.

N5. No new citation storage model. Citations remain `resource_edges` with
`origin='citation'`; `message_retrievals` remains chat telemetry pointing back
with `cited_edge_id`.

N6. No optional compatibility route for old clients. This is a one-user
prototype and a hard cutover.

N7. No lazy "summary now, details later" API in the initial contract. The
assistant message is the primary read. If performance later proves this too
heavy, that must be a new design decision with measured evidence, not a
fallback in this cutover.

---

## 6. Target behavior

### 6.1 Assistant row

Each assistant message renders:

1. Existing answer text and citation chips.
2. Existing active tool cue, now reading from `trust_trail.tool_calls`.
3. A collapsed trust inspector below the answer and outside the answer text
   selection container.
4. Expanded detail on demand:
   - run/model/status summary;
   - prompt assembly budget/manifest summary;
   - ordered tool timeline;
   - retrieval rows grouped by tool call;
   - selected/included/cited state;
   - candidate and rerank ledger rows;
   - citation edge linkage;
   - context-ref-added records;
   - warnings for integrity mismatches.

The collapsed line is terse, for example:

`2 tools - 18 retrieved - 5 selected - 4 cited - 1 reference added`

### 6.2 Reload

After reload, the same assistant message still shows the same completed trail.
It does not rely on replaying old SSE events. It is rebuilt from persisted rows.

### 6.3 Pending and failed runs

Pending/running assistant messages show a partial trust trail with status
`running` and whatever events have arrived. Failed messages show completed tool
attempts, failed tool statuses, run error code, and safe error summary. The
answer text is never hidden because a trust trail has warnings.

### 6.4 Read/inspect tools

`read_resource` and `inspect_resource` appear in the tool timeline because they
already persist `message_tool_calls`. They may have no retrieval rows. The UI
must render non-retrieval tools as first-class tool calls instead of labeling all
non-web tools as "Searching library".

### 6.5 Context-ref-added

If citation finalization creates a conversation context ref, the trust trail shows
the context-ref-added fact on the assistant message and the conversation context
owner still updates the context surface. The message trail is explanatory;
the context surface remains the navigation owner.

---

## 7. Architecture - final state

### 7.1 Ownership map

```
python/nexus/services/message_trust_trails.py
  sole backend read-model owner for assistant trust trails

python/nexus/schemas/conversation.py
  strict wire schema for AssistantTrustTrailOut and nested rows

python/nexus/services/conversations.py
python/nexus/services/chat_run_response.py
python/nexus/services/conversation_branches.py
  attach trust trails to assistant MessageOut values

python/nexus/services/chat_runs.py
  persists tool/retrieval/citation/reference events as today
  emits complete tool_call events for all tool calls

apps/web/src/lib/conversations/types.ts
  one AssistantTrustTrail TypeScript model

apps/web/src/components/chat/useChatMessageUpdates.ts
  folds live SSE deltas into message.trust_trail

apps/web/src/components/chat/AssistantTrustInspector.tsx
  presentational inspector

apps/web/src/components/chat/AssistantMessage.tsx
  places the inspector outside the answer text ref
```

### 7.2 Data ownership

The trust trail service reads, but does not mutate, these owners:

- `chat_runs`: run status, provider/model/key-mode/reasoning-mode, terminal
  error/usage fields already exposed through run responses.
- `chat_prompt_assemblies`: prompt budget, manifest, included/dropped IDs,
  context refs.
- `message_tool_calls`: tool timeline and status.
- `message_retrievals`: retrieval rows and selected/included/cited state.
- `message_retrieval_candidate_ledgers`: candidate ledger rows.
- `message_rerank_ledgers`: rerank/selection pass rows.
- `resource_edges`: citation edges for `source=message:<assistant_message_id>`.
- `chat_run_events`: `context_ref_added` records and event sequencing.
- `citations.build_citation_outs`: chip read model. The trust trail wraps this
  rather than reimplementing chip projection.

The trust trail service is a read-model assembler. It does not become a new
writer, does not own citation numbering, and does not write derived snapshots.

### 7.3 Saved, not transient

"Saved" means every displayed trust fact comes from durable backend state and is
available through the assistant-message API after reload. It does not require a
new `assistant_message_trust_trails` table.

Rejected: a materialized trust-trail table. It would duplicate rows whose real
owners already exist and introduce synchronization bugs. If a later measured
performance problem appears, use an explicitly invalidated cache with this read
model as the source of truth. Do not add that cache in this cutover.

### 7.4 Message document final state

`message_document` is answer content only:

```
MessageDocument
  type: "message_document"
  blocks: TextBlock[]
```

Retrieval rows, tool calls, ledgers, and citation linkage live only in
`trust_trail`. The migration strips old `retrieval_result` blocks from persisted
assistant `message_document` JSON. No read fallback handles old blocks.

### 7.5 Citation composition

Citation chips remain rendered from `message.citations`, built by
`resource_graph.citations.build_citation_outs`.

The trust trail adds debug linkage:

- `citation_edge_id`
- `ordinal`
- `role`
- `target_ref`
- optional `retrieval_id`
- optional `tool_call_id`
- `citation: CitationOut`

The UI must not infer cited state by scanning answer text. The backend supplies
the citation set and linkage.

### 7.6 Prompt assembly disclosure

The trail exposes prompt assembly as a safe summary:

- `prompt_assembly_id`
- `cacheable_input_tokens_estimate`
- `max_context_tokens`
- `reserved_output_tokens`
- `reserved_reasoning_tokens`
- `input_budget_tokens`
- `estimated_input_tokens`
- `prompt_block_manifest`
- `included_message_ids`
- `included_retrieval_ids`
- `included_context_refs`
- `dropped_items`
- `budget_breakdown`

It does not expose the raw system prompt, raw full assembled prompt, provider
request body, hidden reasoning, or API keys.

### 7.7 Integrity notices

The backend may include deterministic integrity notices. These are not answer
verdicts. They only describe ledger/linkage consistency problems, for example:

- retrieval row says `selected=true` but has no citation edge;
- citation edge has no matching retrieval row when one is expected;
- candidate ledger included flag disagrees with linked retrieval included flag;
- prompt assembly references a retrieval id not present for the message;
- `context_ref_added` event target is not present in the citation set.

Warnings render as debug notices and never suppress the assistant answer.

---

## 8. Wire contract

### 8.1 Message shape

`MessageOut` becomes role-discriminated in spirit even if implemented as one
Pydantic class:

- assistant messages: `trust_trail: AssistantTrustTrailOut`
- user/system messages: `trust_trail: None`

The backend invariant is strict: an assistant `MessageOut` always has a trust
trail. A pending assistant message has an empty/running trail, not `None`.

### 8.2 `AssistantTrustTrailOut`

```python
class AssistantTrustTrailOut(BaseModel):
    schema_version: Literal["assistant_trust_trail.v1"]
    assistant_message_id: UUID
    conversation_id: UUID
    chat_run_id: UUID | None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    run: TrustRunOut | None
    prompt: TrustPromptAssemblyOut | None
    tool_calls: list[TrustToolCallOut]
    citations: list[TrustCitationOut]
    context_refs_added: list[TrustContextRefAddedOut]
    integrity_notices: list[TrustIntegrityNoticeOut]
    created_at: datetime
    updated_at: datetime
```

### 8.3 Run summary

```python
class TrustRunOut(BaseModel):
    run_id: UUID
    model_id: UUID
    provider: str
    model_name: str
    reasoning_mode: str | None
    key_mode: str | None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    usage: dict[str, JsonValue] | None
    error_code: str | None
    final_chars: int | None
    started_at: datetime | None
    completed_at: datetime | None
```

### 8.4 Tool call

```python
class TrustToolCallOut(BaseModel):
    id: UUID
    tool_name: str
    tool_call_index: int
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    scope: str
    requested_types: list[str]
    query_hash: str | None
    latency_ms: int | None
    result_count: int
    selected_count: int
    error_code: str | None
    provider_request_ids: list[str]
    result_refs: list[dict[str, Any]]
    selected_context_refs: list[dict[str, Any]]
    retrievals: list[TrustRetrievalOut]
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut]
    rerank_ledgers: list[MessageRerankLedgerOut]
    created_at: datetime
    updated_at: datetime
```

`tool_name` is a string, not a two-value literal. Strictness belongs in the
payload shape, not in pretending only search tools exist.

### 8.5 Retrieval row

`TrustRetrievalOut` is `MessageRetrievalOut` plus linkage:

- `cited_edge_id: UUID | None`
- `citation_number: int | None`
- `citation_role: CitationRole | None`
- `included_in_prompt_source: "retrieval" | "candidate_ledger" | "prompt_assembly" | "none"`

The service must be honest about `included_in_prompt`. If the source of truth is
not known for a row, it returns `false` and an explicit source of `"none"`. It
must not infer prompt inclusion from "selected" or "cited".

### 8.6 Citation row

```python
class TrustCitationOut(BaseModel):
    citation_edge_id: UUID
    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    retrieval_id: UUID | None
    tool_call_id: UUID | None
    citation: CitationOut
```

### 8.7 Reference-added row

`TrustContextRefAddedOut` matches the strict `context_ref_added` payload plus
`chat_run_event_seq` and `citation_edge_id | None` when linkable.

### 8.8 Candidate/rerank rows

Reuse the existing Pydantic row shapes, but move them under
`TrustToolCallOut`. The old standalone response types can remain as internal
aliases only if they are used by the trust schema. They are not a route-level
capability after this cutover.

---

## 9. API design

### 9.1 Primary API

The primary API is existing message reads:

- `GET /conversations/{conversation_id}/messages`
- `GET /chat-runs/{run_id}` reconcile response
- branch/path message reads that return `MessageOut`

Every assistant `MessageOut` includes `trust_trail`.

### 9.2 Deleted APIs

Delete these FastAPI routes and their Next.js proxies:

- `GET /messages/{message_id}/retrieval-candidate-ledgers`
- `GET /messages/{message_id}/rerank-ledgers`

They are replaced by `message.trust_trail.tool_calls[].candidate_ledgers` and
`message.trust_trail.tool_calls[].rerank_ledgers`.

### 9.3 BFF

No new BFF business logic. Existing `/api/*` message/chat routes proxy the
FastAPI response. The BFF does not assemble trust data.

### 9.4 SSE

Streaming remains the direct FastAPI exception. SSE deltas update the same
frontend `AssistantTrustTrail` shape.

Required contract changes:

- `tool_call.tool_name` accepts any non-empty tool name.
- every persisted `message_tool_calls` write emits a `tool_call` event for live
  runs, including `read_resource` and `inspect_resource`;
- retrieval-bearing tools emit `retrieval_result`;
- `citation_index` still refreshes `message.citations` and also updates
  `trust_trail.citations`;
- `context_ref_added` still updates conversation context refs and also appends to
  `trust_trail.context_refs_added`;
- `done` triggers reconcile; reconcile response wins.

No old event fallback is kept. Tests update to the new strict grammar.

---

## 10. Backend implementation plan

### S0 - Contract and indexes

- Add any missing read indexes needed by the trust service:
  - `chat_prompt_assemblies(assistant_message_id)`
  - `chat_run_events(run_id, event_type, seq)`
  - `message_retrievals(cited_edge_id)` if linkage lookup needs it
- Confirm existing indexes on `message_tool_calls(assistant_message_id,
  tool_call_index)` and candidate/rerank tool-call joins.
- Add migration to strip `retrieval_result` blocks from existing
  `messages.message_document`.

### S1 - Schemas

Edit `python/nexus/schemas/conversation.py`:

- add trust-trail Pydantic models;
- add `trust_trail` to `MessageOut`;
- remove `MessageDocumentRetrievalResultBlock`;
- make `MessageDocumentBlock` text-only;
- expand `ChatRunToolCallEventPayload.tool_name` and
  `ChatRunRetrievalResultEventPayload.tool_name` beyond app/web-only literals.

Edit `apps/web/src/lib/conversations/types.ts`:

- add `AssistantTrustTrail` and nested types;
- add `trust_trail` to assistant messages;
- delete top-level `tool_calls` and `retrievals`;
- make `MessageDocument.blocks` text-only.

### S2 - Read model service

Create `python/nexus/services/message_trust_trails.py`.

Public API:

```python
def build_assistant_trust_trail(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> AssistantTrustTrailOut:
    ...

def build_assistant_trust_trails(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> dict[UUID, AssistantTrustTrailOut]:
    ...
```

The batch function is the default for message pages to avoid N+1 queries.

Rules:

- verify the message is visible through the conversation read predicate before
  returning a trail;
- group tool calls by `tool_call_index`;
- nest retrievals, candidate ledgers, and rerank ledgers under their tool call;
- build citations from resource edges and `build_citation_outs`;
- link retrievals to citation edges through `message_retrievals.cited_edge_id`;
- read `context_ref_added` from run events;
- emit deterministic integrity notices only.

### S3 - Attach to message APIs

Edit:

- `python/nexus/services/conversations.py`
- `python/nexus/services/chat_run_response.py`
- `python/nexus/services/conversation_branches.py`
- any other `MessageOut` construction sites

All assistant `MessageOut` values get a `trust_trail`. User/system messages get
`None`.

Delete the standalone ledger route module and route registration after callers
move.

### S4 - Remove retrieval telemetry from message documents

Edit:

- `python/nexus/services/chat_run_message_blocks.py`
- finalization paths that call `message_document_with_run_components`
- frontend `useChatMessageUpdates` retrieval block append path

Final state:

- finalization writes text-only `message_document`;
- live deltas update only the text block;
- retrieval events update only `message.trust_trail`;
- persisted old retrieval blocks have been stripped by migration.

### S5 - Complete tool event coverage

Edit `python/nexus/services/chat_runs.py`:

- every persisted tool call emits `tool_call` during live runs;
- `read_resource` and `inspect_resource` have visible start/complete/error
  events;
- retrieval-bearing tools continue to emit `retrieval_result`;
- tool event payloads include stable `tool_call_id` whenever the row exists.

Do not invent separate event types for read/inspect. A tool is a tool.

### S6 - Frontend inspector

Add:

- `apps/web/src/components/chat/AssistantTrustInspector.tsx`
- `apps/web/src/components/chat/assistantTrust.ts` or
  `apps/web/src/lib/conversations/assistantTrust.ts` for pure summarizers
- local CSS in the existing chat message stylesheet

Edit:

- `AssistantMessage.tsx`: render the inspector after
  `AssistantEvidenceDisclosure` and before `AssistantSelectionPopover`.
- `ToolActivity`: read active tool calls from `trust_trail.tool_calls`.
- `useChatMessageUpdates.ts`: fold SSE into `message.trust_trail`.

The inspector is outside the answer `ref`. Assistant answer selection must still
compare rendered answer text to `conversationMessageText(message)` without
debug text contamination.

---

## 11. Frontend product design

This is a developer-grade product surface, not a raw log dump.

Collapsed:

- one-line summary;
- status icon;
- warning count if integrity notices exist;
- no card-in-card layout;
- no large explanatory copy.

Expanded:

- tabs or sections for `Run`, `Prompt`, `Tools`, `Citations`, `References`;
- compact timeline sorted by tool index and event time;
- source titles and snippets only where already safe for citation display;
- stable IDs visible/copyable only in compact monospace secondary text;
- citation rows use the same `onCitationActivate` path as answer chips;
- failed rows remain visible with error code.

The component is presentational. It receives an `AssistantTrustTrail` and
callbacks. It does not fetch, join, or infer backend facts.

---

## 12. Composition with other systems

### 12.1 Citations

Citation rendering still belongs to `CitationOut` and `ReaderCitationData`.
The trust trail composes by wrapping those outputs with edge IDs and retrieval
linkage. It does not replace the citation chip system.

### 12.2 Conversation context refs

`context_ref_added` continues to update `useConversationContextRefs` and the
context surface. The trust trail mirrors the event on the originating
assistant message for debug causality.

### 12.3 Prompt tracking

`chat_prompt_assemblies` remains the prompt ledger owner. The trust trail reads
safe assembly summaries. It does not repair or reinterpret prompt tracking. If
`included_retrieval_ids` is empty because a retrieval was generated after prompt
assembly, the trail must say so honestly.

### 12.4 Resource graph

Citation edges remain the durable provenance edge. The trust trail reads them
for message-local inspection and does not add resource graph mutations.

### 12.5 LLM/provider runtime

Hidden provider reasoning, encrypted reasoning content, provider raw payloads,
and raw request bodies remain outside the product read model. `llm_calls` stays
operator-queryable. A later observability export can map trust-trail rows and
provider ledgers into traces, but the assistant-message product surface remains
safe and typed.

### 12.6 Search and retrieval

`app_search` and `web_search` keep their domain writers. The trust trail reads
their rows uniformly. Future retrieval tools must write `message_tool_calls` and
`message_retrievals` through the existing validated writers to appear in the
trail.

---

## 13. Security and data classification

Allowed in UI:

- provider/model names;
- run status/error code;
- token/budget summaries;
- prompt block manifest metadata;
- included message/retrieval IDs;
- context ref labels and resource refs already visible to the user;
- tool names/status/timing/counts;
- retrieval source titles, snippets, scores, locators, selected/cited flags;
- candidate/rerank ledger rows;
- citation edge IDs and target refs;
- context-ref-added resource refs.

Not allowed in UI:

- API keys or key fingerprints beyond existing key-mode labels;
- hidden provider reasoning or encrypted reasoning blobs;
- raw provider request/response payloads;
- raw full prompt text;
- raw tool arguments/results that are not already safe retrieval/citation data;
- stack traces or operator `error_detail`;
- `llm_calls` raw rows.

All trust schemas use `extra="forbid"` / strict TypeScript guards. Unknown data
fails at the boundary.

---

## 14. Acceptance criteria

AC1. `GET /conversations/{id}/messages` returns `trust_trail` for every
assistant message and `null` for non-assistant messages.

AC2. `GET /chat-runs/{id}` returns an assistant message whose `trust_trail`
matches the message-list read for the same message.

AC3. `message_document` contains text blocks only. Old retrieval blocks are
removed by migration and rejected by schema.

AC4. Candidate ledgers and rerank ledgers are visible under their tool calls in
the assistant trust trail. The old standalone ledger routes and Next.js proxies
are deleted.

AC5. `read_resource` and `inspect_resource` appear in the live and reloaded tool
timeline.

AC6. `citation_index` produces both normal citation chips and trust-trail
citation linkage with `citation_edge_id`.

AC7. `context_ref_added` updates both the conversation context refs owner and the
assistant message trust trail.

AC8. The inspector renders outside the assistant answer selection container and
does not break selection/fork behavior.

AC9. A failed run shows partial tool/retrieval trail and safe error code without
hiding the answer.

AC10. No UI displays hidden provider reasoning, raw prompts, API key material,
or operator-only `llm_calls` details.

AC11. Live stream completion followed by reconcile does not clobber citations or
trust facts.

AC12. Reload after completion shows the same trust summary counts as the live
completed message.

---

## 15. Test plan

### Backend

Add `python/tests/test_assistant_message_trust_trail.py`:

- assistant message with no tools gets empty complete trail;
- app search tool gets tool call, retrievals, candidates, rerank rows;
- selected retrieval with citation edge links retrieval to citation;
- unselected retrieval remains telemetry-only;
- `context_ref_added` event appears in trail;
- prompt assembly summary is present and raw prompt text is absent;
- `read_resource` / `inspect_resource` tool calls appear without retrieval rows;
- failed tool/run returns safe statuses and error codes;
- integrity notices are deterministic for seeded mismatch cases;
- batch builder returns same data as single builder.

Update existing tests:

- `test_chat_runs.py`: `GET /chat-runs/{id}` and message-list parity.
- `test_message_citation_contracts.py`: trust citation edge IDs.
- `test_chat_run_stream.py`: expanded `tool_call.tool_name` grammar and
  read/inspect events.
- delete or rewrite `test_message_retrievals.py` route tests to assert the new
  message read model.
- migration test proving retrieval blocks are stripped from old
  `message_document`.

### Frontend unit/component

Add:

- `assistantTrust.test.ts`: summary counts, warning counts, citation/retrieval
  linkage, safe empty states.
- `AssistantTrustInspector.test.tsx`: collapsed/expanded rendering, actions,
  failed states, no raw prompt display.
- `useChatRunTail.test.tsx`: live fold of tool/retrieval/citation/reference into
  `trust_trail`, reconnect/reconcile behavior.

Update:

- `AssistantMessage.test.tsx`: inspector placement and selection/fork
  non-regression.
- `useChatMessageUpdates.test.tsx`: no retrieval blocks in `message_document`;
  trust trail updated instead.
- `events.test.ts`: strict expanded tool-name payloads.
- `types`/citation tests as needed for `TrustCitationOut`.

### E2E

Extend real-media chat citation coverage:

- run chat with retrieval;
- assert inspector summary count matches visible chips;
- reload page;
- assert same inspector summary;
- expand citation detail and activate source through the same citation callback.

---

## 16. File inventory

Backend:

- `python/nexus/schemas/conversation.py`
- `python/nexus/services/message_trust_trails.py` (new)
- `python/nexus/services/conversations.py`
- `python/nexus/services/chat_run_response.py`
- `python/nexus/services/conversation_branches.py`
- `python/nexus/services/chat_run_message_blocks.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/api/routes/message_retrievals.py` (delete)
- route registration for `message_retrievals` (remove)
- `python/nexus/db/models.py` (indexes only if needed)
- Alembic migration for text-only `message_document` cleanup and indexes

Frontend:

- `apps/web/src/lib/conversations/types.ts`
- `apps/web/src/lib/conversations/assistantTrust.ts` (new)
- `apps/web/src/components/chat/AssistantTrustInspector.tsx` (new)
- `apps/web/src/components/chat/AssistantMessage.tsx`
- `apps/web/src/components/chat/useChatMessageUpdates.ts`
- `apps/web/src/components/chat/useChatRunTail.ts`
- `apps/web/src/lib/api/sse/events.ts`
- `apps/web/src/app/api/messages/[messageId]/retrieval-candidate-ledgers/route.ts` (delete)
- `apps/web/src/app/api/messages/[messageId]/rerank-ledgers/route.ts` (delete)
- chat message CSS module

Docs:

- `docs/modules/chat.md`
- `docs/architecture.md`
- this cutover spec moves to Implemented only after the acceptance criteria pass.

---

## 17. Key decisions

D1. The trust trail is a read model over existing durable rows, not a new truth
table.

D2. `message_document` becomes text-only. Telemetry belongs in the trust trail.

D3. Assistant messages are the primary trust API. Standalone ledger routes are
deleted.

D4. Live SSE deltas fold into the same frontend shape that reload returns.

D5. All tool calls are first-class in the trail. Search tools are not special
except that they have retrieval rows.

D6. Citation chips remain separate from trust debug linkage. Rendering and debug
causality are related but not the same contract.

D7. Prompt assembly disclosure is summary-only and safe by default.

D8. Integrity notices are ledger consistency notices, not truth evaluation.

D9. Reconcile response wins after stream completion.

D10. No raw provider reasoning, raw prompt, or operator ledger UI.

---

## 18. Rejected alternatives

### A. Frontend-only inspector over existing folded fields

Rejected because it dies on reload, misses read/inspect tools, cannot show
prompt assembly, and encourages DOM/citation inference.

### B. New `assistant_message_trust_trails` table

Rejected because it duplicates existing durable owners and can drift. The read
model should be deterministic over source rows.

### C. Keep retrieval telemetry blocks for backward compatibility

Rejected. The blocks duplicate `message_retrievals` and keep telemetry inside
answer content. Hard cutover strips them.

### D. Keep standalone ledger APIs

Rejected. They expose the same capability in another shape and force the UI to
compose multiple APIs to explain one assistant message.

### E. Display raw prompt/provider payloads

Rejected. It is unsafe, noisy, and conflicts with the LLM module's provider
reasoning boundary. The trail exposes safe summaries and linkage.

---

## 19. Rollout order

1. Add schemas and migration for text-only message documents.
2. Build backend trust-trail service and attach to all assistant `MessageOut`
   constructors.
3. Delete standalone ledger routes/proxies.
4. Expand tool-call event grammar and emit read/inspect tool events.
5. Move frontend live fold state from top-level `tool_calls`/`retrievals` into
   `message.trust_trail`.
6. Add `AssistantTrustInspector` and switch `ToolActivity` to the trust trail.
7. Delete retrieval block append paths and old frontend types.
8. Land backend, frontend, and e2e tests.
9. Update chat/architecture docs and mark this spec Implemented.

There is no intermediate compatibility milestone. Each slice can be committed
only when the repo stays internally consistent.
