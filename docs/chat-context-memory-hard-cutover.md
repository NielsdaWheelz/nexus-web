# Chat Context Memory Hard Cutover

## Purpose

Replace bounded recent-history prompting with production-grade conversation
context management for long chats.

The product model is:

- the message log remains the immutable conversation source of truth,
- conversation state is maintained as typed, auditable memory records,
- media, highlights, annotations, fragments, transcripts, web results, and prior
  messages are represented by resolvable source references,
- summaries describe conversation state only,
- source-grounded details come from retrieval or context lookup, not from a
  lossy summary,
- prompt assembly is centralized, budgeted, observable, and deterministic.

This is a hard cutover. The final state has no legacy last-40-message prompt
path, no count-only history truncation, no prompt-size warning without
enforcement, no opaque source-free memory, no whole-document summary memory, no
silent fallback to unscoped retrieval, no duplicate prompt renderers, and no
backward-compatible compatibility mode.

## Current Baseline

The repo already has the right foundation for this cutover:

- durable conversations, messages, chat runs, run events, message contexts,
  tool calls, and retrieval rows,
- durable conversation scopes for `general`, `media`, and `library`,
- backend-owned app search and web search tools,
- persisted `context_ref`, `result_ref`, selected retrievals, deep links, and
  source scope metadata,
- scoped prompt metadata and backend-rendered XML context blocks,
- frontend scope chips, context chips, chat surfaces, and run tailing.

The main gaps are:

- `load_prompt_history` is count-based and returns up to 40 complete
  user/assistant messages, not a token-budgeted, pair-aware working set,
- summaries/state snapshots do not exist in the database,
- there is no unified context lookup service for arbitrary stored refs,
- prompt budget validation exists as a character helper but is not the chat-run
  assembly gate,
- app search query rewriting is local string logic rather than a first-class
  retrieval planning step,
- prompt assembly is distributed across chat run execution, context rendering,
  app search rendering, web search rendering, and prompt rendering,
- there is no prompt assembly ledger to audit what was included, dropped, and
  why.

## External Rationale

This design follows the current long-context consensus:

- OpenAI conversation state and compaction docs separate conversation state from
  context-window management and note that compaction items can be opaque:
  <https://developers.openai.com/api/docs/guides/conversation-state> and
  <https://developers.openai.com/api/docs/guides/compaction>.
- OpenAI retrieval docs support query rewriting, scoped filtering, ranking, and
  chunked retrieval as the evidence path:
  <https://developers.openai.com/api/docs/guides/retrieval>.
- Anthropic context editing treats context as a finite resource and supports
  clearing old tool results while preserving application-side history:
  <https://platform.claude.com/docs/en/build-with-claude/context-editing>.
- LangGraph separates thread-scoped short-term memory from namespace-scoped
  long-term memory:
  <https://docs.langchain.com/oss/javascript/concepts/memory>.
- MemGPT frames long-running agents as OS-style memory hierarchy rather than
  one ever-growing prompt:
  <https://research.memgpt.ai/>.
- Lost in the Middle and Context Rot both show that large context windows do
  not remove the need for careful context construction:
  <https://arxiv.org/abs/2307.03172> and
  <https://www.trychroma.com/research/context-rot>.
- LongMemEval breaks long-term memory quality into indexing, retrieval, and
  reading, and evaluates extraction, multi-session reasoning, temporal
  reasoning, updates, and abstention:
  <https://arxiv.org/abs/2410.10813>.
- RAG evaluation practice tracks context precision, context recall,
  faithfulness, noise sensitivity, and tool accuracy:
  <https://docs.ragas.io/en/stable/concepts/metrics/>.

## Goals

- Preserve long conversation continuity without stuffing full transcripts into
  every prompt.
- Keep source-grounded facts attached to source refs that can be rehydrated.
- Prevent summaries from becoming unreviewable shadow truth.
- Make prompt assembly one backend service with one primary API.
- Use model context windows deliberately with explicit budgets and reserves.
- Keep recent history pair-aware and token-aware.
- Preserve user goals, decisions, constraints, corrections, unresolved
  questions, and assistant commitments across long chats.
- Retrieve specific source details just in time from app search or context
  lookup.
- Persist every memory item and state snapshot with coverage, prompt version,
  source refs, and invalidation metadata.
- Maintain provider-neutral durable state. Provider-native compaction can be an
  adapter optimization only, never the application memory source of truth.
- Make inclusion, exclusion, and budget decisions observable per chat run.
- Add regression tests and offline evals for long-memory behavior.

## Non-Goals

- Do not build compiled library wikis in this cutover.
- Do not implement cross-conversation user personalization memory.
- Do not expose arbitrary user-editable memory files.
- Do not replace app search with a new search product.
- Do not summarize full media, PDFs, transcripts, books, or libraries into
  conversation memory.
- Do not use provider-native opaque compaction as durable product state.
- Do not add a second chat surface, second send endpoint, or second prompt path.
- Do not keep legacy history truncation as a fallback.
- Do not build a general agent framework.
- Do not change conversation sharing semantics.

## Target Behavior

### Long Chat Continuity

- A conversation with hundreds of turns still remembers:
  - user-stated goals,
  - important constraints,
  - accepted decisions,
  - rejected approaches,
  - unresolved questions,
  - active tasks,
  - prior assistant commitments,
  - corrections that supersede earlier claims.
- The assistant can answer "what did we decide?" from conversation memory and
  recent history.
- The assistant can answer "where did that come from?" only when the relevant
  memory item carries resolvable source refs.
- If the answer requires exact source text and no source text has been
  retrieved, the backend retrieves or looks up the referenced content before the
  final model call.
- If no resolvable evidence exists for a source-grounded claim, the assistant
  says the conversation state does not contain enough evidence.

### Source And Media Handling

- Media, fragments, transcript chunks, highlights, annotations, web results,
  and prior messages are not summarized into durable memory as if the summary
  were the source.
- A memory item may contain a short conversational claim, decision, or note, but
  source-grounded claims require `source_refs`.
- Source refs carry enough metadata to rehydrate content through
  `context_lookup` or app search:
  - source type,
  - stable source id,
  - conversation id and message seq when relevant,
  - `context_ref` and `result_ref` when relevant,
  - media id when available,
  - fragment id, offsets, page, timestamp, or deep link when available,
  - retrieval id or message context id when available,
  - checksum/version metadata when available.
- The prompt may include a pointer table saying a source exists, but pointer
  metadata alone is never evidence for a factual answer.

### Conversation State

- Conversation state snapshots cover only older turns.
- Recent turns remain verbatim when budget permits.
- A snapshot records `covered_through_seq`; the prompt never includes both a
  complete snapshot and all of the same covered messages as routine input.
- New messages after `covered_through_seq` are either recent history or pending
  compaction input.
- A snapshot can be invalidated by prompt-version changes, source deletion,
  permission changes, or failed validation.
- Corrections supersede older memory items instead of appending contradictory
  facts indefinitely.

### Retrieval

- Retrieval planning uses:
  - current user message,
  - conversation scope metadata,
  - bounded recent history,
  - active conversation memory items,
  - state snapshot,
  - attached contexts,
  - selected source refs.
- Scoped chats keep the existing hard boundary:
  - `general` can search `all` when policy allows,
  - `media` searches `media:<media_id>`,
  - `library` searches `library:<library_id>`,
  - public web search remains explicit.
- Search and lookup results are persisted as tool calls and retrieval rows.
- Retrieval rows, message contexts, and memory source refs are the only source
  of UI citation objects.
- Query rewriting is a service step with structured output and tests. It is not
  hidden string manipulation inside app search.

### Prompt Assembly

- Every chat run uses `context_assembler`.
- The assembler builds one provider-neutral request from typed parts:
  - system instructions,
  - conversation scope,
  - active conversation state snapshot,
  - active memory items,
  - pointer refs,
  - pending attached contexts,
  - selected retrieved evidence,
  - pair-aware recent history,
  - current user message.
- Prompt budgets are token budgets, not character caps.
- Budget reservations include output tokens and reasoning tokens.
- The final request is validated before provider execution.
- If required content cannot fit, the run fails with a typed context-too-large
  error instead of sending a best-effort oversized prompt.

### User Interface

- Chat still uses the existing conversation panes, chat surface, composer, scope
  chip, context chips, and run tailing.
- Conversation context UI exposes:
  - conversation scope,
  - pending contexts,
  - selected retrieval citations,
  - active conversation memory/state coverage,
  - source refs attached to memory items.
- Users can inspect why an answer cites a source through persisted retrievals
  and context refs.
- The UI does not display provider-native opaque compaction items.

## Final State

### Kept

- `POST /api/chat-runs` remains the only send endpoint.
- Durable chat runs remain the execution source of truth.
- `messages` remains the immutable transcript.
- `message_contexts` remains the per-message attached context table.
- `message_tool_calls` and `message_retrievals` remain the durable tool and
  retrieval metadata tables.
- Conversation scopes remain `general | media | library`.
- App search and web search remain backend-owned tools.
- Next.js BFF routes remain transport-only.
- Prompt XML remains backend-rendered with inline escaping.

### Replaced

- Replace `load_prompt_history` as the chat-run history path with
  token-budgeted context assembly.
- Replace ad hoc app-search query rewriting with `retrieval_planner`.
- Replace prompt-size warning logs with enforced budget validation.
- Replace direct prompt block accumulation in `chat_runs` with a typed assembly
  artifact.
- Replace summary-as-memory thinking with typed memory items plus source refs.

### Removed

- No `MAX_HISTORY_TURNS` prompt behavior.
- No count-only history truncation.
- No legacy prompt assembly branch.
- No fallback raw-history prompt if state snapshot lookup fails.
- No source-free durable summary for source-grounded claims.
- No provider-specific opaque memory as durable state.
- No unscoped app-search fallback inside scoped conversations.
- No model-authored citation ids or citation strings.
- No UI path that treats pointer metadata as evidence text.

## Architecture

```text
ChatComposer
  POST /api/chat-runs

Next.js BFF
  transport-only proxy

FastAPI chat_runs route
  validate request
  call chat_runs service

chat_runs service
  create durable run
  persist user message and attached contexts
  execute run through context_assembler

context_assembler
  load conversation, scope, current message, attached contexts
  load latest valid state snapshot
  load active memory items after snapshot coverage
  choose pair-aware recent history
  call retrieval_planner
  execute app_search, web_search, and context_lookup as needed
  allocate token budgets
  render prompt parts
  persist chat_prompt_assemblies ledger
  return LLMRequest

llm router
  provider-neutral streaming call

chat_runs service
  persist deltas, citations, usage, status
  schedule memory extraction / snapshot refresh

conversation_memory service
  extract typed memory candidates
  validate source refs
  supersede stale memory
  maintain state snapshots
```

## Data Model

### SourceRef

Use one source-ref contract across memory, snapshots, context lookup, and prompt
assembly.

```json
{
  "type": "message | message_context | message_retrieval | app_context_ref | web_result",
  "id": "stable source id",
  "conversation_id": "uuid when relevant",
  "message_id": "uuid when relevant",
  "message_seq": 42,
  "tool_call_id": "uuid when relevant",
  "retrieval_id": "uuid when relevant",
  "context_ref": { "type": "fragment", "id": "uuid" },
  "result_ref": { "type": "search_result", "id": "opaque stable id" },
  "media_id": "uuid when relevant",
  "deep_link": "/media/...",
  "location": {
    "page": 12,
    "fragment_id": "uuid",
    "t_start_ms": 12345,
    "start_offset": 100,
    "end_offset": 180
  },
  "source_version": "optional version or checksum"
}
```

Rules:

- `type` is finite and exhaustively handled.
- Every source ref is permission-checked at hydration time.
- A source ref that cannot be resolved is invalid, not silently ignored when it
  supports an active memory claim.
- Source refs may include short display labels, but source labels are not
  evidence.

### conversation_memory_items

Add a table for durable typed memory.

- `id`
- `conversation_id`
- `kind`: `goal | constraint | decision | correction | open_question |
  task | assistant_commitment | user_preference | source_claim`
- `status`: `active | superseded | invalid`
- `body`
- `source_required`
- `confidence`
- `valid_from_seq`
- `valid_through_seq`
- `supersedes_id`
- `created_by_message_id`
- `prompt_version`
- `memory_version`
- `invalid_reason`
- `created_at`
- `updated_at`

Constraints:

- `body` is bounded.
- `kind`, `status`, and `invalid_reason` are finite.
- `source_claim` requires at least one source ref.
- `source_required = true` requires at least one source ref.
- `confidence` is bounded from 0 to 1.
- `valid_from_seq <= valid_through_seq` when both are present.

### conversation_memory_item_sources

Normalize memory evidence sources instead of burying all provenance in one JSON
array.

- `id`
- `memory_item_id`
- `ordinal`
- `source_ref`
- `evidence_role`: `supports | contradicts | supersedes | context`
- `created_at`

Constraints:

- `source_ref` is a JSON object matching the `SourceRef` contract.
- `ordinal` is unique per memory item.
- `evidence_role` is finite.

### conversation_state_snapshots

Add a table for compact, auditable conversation state.

- `id`
- `conversation_id`
- `covered_through_seq`
- `state_text`
- `state_json`
- `source_refs`
- `memory_item_ids`
- `prompt_version`
- `snapshot_version`
- `status`: `active | superseded | invalid`
- `invalid_reason`
- `created_at`
- `updated_at`

Rules:

- `state_text` is conversation state, not source-document summary.
- `state_json` stores structured goals, constraints, decisions, corrections,
  open questions, active tasks, and source-ref index entries.
- `source_refs` contains refs used directly by the snapshot.
- `memory_item_ids` links active memory items represented in the snapshot.
- Only one active snapshot exists per conversation.
- A snapshot covers a contiguous prefix of completed messages.

### chat_prompt_assemblies

Add a per-run prompt assembly ledger.

- `id`
- `chat_run_id`
- `conversation_id`
- `assistant_message_id`
- `model_id`
- `prompt_version`
- `assembler_version`
- `snapshot_id`
- `max_context_tokens`
- `reserved_output_tokens`
- `reserved_reasoning_tokens`
- `input_budget_tokens`
- `estimated_input_tokens`
- `included_message_ids`
- `included_memory_item_ids`
- `included_retrieval_ids`
- `included_context_refs`
- `dropped_items`
- `budget_breakdown`
- `created_at`

Rules:

- The ledger is persisted before provider execution.
- `dropped_items` records why each eligible item was excluded.
- The ledger never stores secrets or raw provider request payloads.
- The ledger is enough to debug context behavior without reconstructing from
  logs.

## Services

### context_assembler

Add `python/nexus/services/context_assembler.py`.

Responsibilities:

- Own the only prompt assembly API used by chat runs.
- Load typed state from the database.
- Select recent message pairs.
- Select active memory items.
- Call retrieval planning.
- Execute context lookup for referenced sources.
- Allocate token budgets.
- Render typed prompt parts.
- Validate the final request.
- Persist the prompt assembly ledger.

Primary API:

```python
def assemble_chat_context(
    db: Session,
    *,
    run: ChatRun,
    model: Model,
    max_output_tokens: int,
) -> ContextAssembly:
    ...
```

### prompt_budget

Add `python/nexus/services/prompt_budget.py`.

Responsibilities:

- Estimate tokens with provider/model-specific tokenizers when available.
- Fall back to a conservative estimator only when no tokenizer exists for that
  provider.
- Reserve output and reasoning tokens before allocating input.
- Allocate budgets by typed lane.
- Produce structured drop reasons.
- Raise a typed error when mandatory context cannot fit.

Budget lanes:

- system instructions,
- scope metadata,
- current user message,
- pending attached contexts,
- retrieved evidence,
- state snapshot,
- active memory items,
- recent history,
- pointer refs.

### retrieval_planner

Add `python/nexus/services/retrieval_planner.py`.

Responsibilities:

- Produce structured app-search, web-search, and context-lookup requests.
- Use current user text, recent history, scope metadata, snapshots, memory, and
  source refs.
- Never answer the user.
- Never expand scoped app search outside the persisted conversation scope.
- Persist query hashes, not raw private queries, following existing app-search
  practice.

Planner output:

```json
{
  "app_search": {
    "enabled": true,
    "query": "standalone retrieval query",
    "scope": "media:...",
    "types": ["fragment", "annotation", "transcript_chunk"]
  },
  "context_lookup": [
    {
      "source_ref": { "type": "message_retrieval", "retrieval_id": "..." },
      "purpose": "hydrate exact evidence for active decision"
    }
  ],
  "web_search": {
    "enabled": false,
    "reason": "web search not requested"
  }
}
```

### context_lookup

Add `python/nexus/services/context_lookup.py`.

Responsibilities:

- Hydrate `SourceRef` and `context_ref` values into bounded evidence blocks.
- Centralize the logic currently embedded in app-search rendering.
- Recheck permissions for every lookup.
- Return typed failures instead of silent omission.
- Support `media`, `highlight`, `annotation`, `fragment`,
  `transcript_chunk`, `message`, `podcast`, `message_retrieval`, and
  `web_result`.

This service is internal in this cutover. Public API exposure is a separate
decision.

### conversation_memory

Add `python/nexus/services/conversation_memory.py`.

Responsibilities:

- Extract typed memory candidates after completed chat runs.
- Validate source refs.
- Merge duplicates.
- Supersede stale or contradicted memory.
- Maintain the active state snapshot.
- Invalidate snapshots and memory when source refs become unreadable or stale.

Extraction is allowed to use an LLM with structured output, but the stored
result is validated by deterministic schema and source-ref rules.

### chat_prompt

Keep provider-neutral prompt rendering, but make it render typed assembled
parts instead of receiving ad hoc `context_blocks`.

Required behavior:

- Escape every interpolated XML value inline.
- Render source refs separately from evidence text.
- Tell the model that pointer metadata is not evidence.
- Tell the model to cite only backend-provided context and retrieval sources.
- Branch exhaustively on scope, context part type, and memory item kind.

### chat_runs

Keep run creation, streaming, cancellation, and persistence in
`python/nexus/services/chat_runs.py`.

Change execution to:

1. load the run,
2. resolve model/key/rate limits,
3. call `assemble_chat_context`,
4. stream the provider response,
5. finalize message/run state,
6. schedule memory extraction and snapshot refresh.

`chat_runs` must not manually append prompt context blocks after the cutover.

## Prompt Rules

- The prompt includes source text only from attached contexts, selected
  retrievals, or context lookup.
- The prompt may include source refs without source text, but refs are only
  navigation/retrieval handles.
- A source-grounded answer requires retrieved or looked-up evidence text.
- A conversation-state answer may use active memory items and snapshots.
- Contradictions are surfaced instead of averaged.
- Recent corrections outrank older memory.
- User-authored requirements outrank assistant inferences.
- Provider-native compaction output is never shown to the user and never stored
  as conversation memory.
- Prompt XML escaping happens at each generated-text use site.
- The final provider request must fit the computed model budget.

## Context Budget Policy

- Compute `max_context_tokens` from the selected model.
- Reserve output tokens from chat-run reasoning mode.
- Reserve reasoning tokens for reasoning-capable models.
- Allocate mandatory lanes first:
  - system,
  - scope,
  - current user,
  - attached contexts explicitly selected by the user.
- Allocate evidence lanes next:
  - context lookup outputs required by memory/source refs,
  - selected app-search results,
  - selected web-search results.
- Allocate continuity lanes next:
  - active snapshot,
  - active memory items,
  - recent message pairs.
- Allocate optional pointer refs last.
- Drop optional items oldest-first within lane unless a stronger lane-specific
  ranking exists.
- Never drop half of a user/assistant pair unless the assistant message is
  pending or errored.
- Never drop a correction while retaining the superseded item as active.
- Never silently truncate a single evidence block; ask the renderer for a
  smaller bounded block or fail.

## Background Jobs

Memory extraction and snapshot refresh run after successful chat runs.

Trigger rules:

- after every completed assistant message, extract memory candidates for the
  latest pair,
- when unsnapshotted completed messages exceed a token or sequence threshold,
  refresh the active snapshot,
- when prompt version changes, invalidate old active snapshots and rebuild on
  demand,
- when source permissions or source versions change, invalidate affected memory
  items and snapshots.

Background jobs are optimizations for latency. If no valid snapshot exists at
send time, `context_assembler` builds from recent messages and active memory
items within budget or fails with a typed error. It does not fall back to the
legacy last-40 path.

## Observability

Emit structured logs and metrics for:

- prompt assembly token budget,
- included and dropped lane counts,
- snapshot coverage,
- active memory item count,
- source-ref hydration success/failure,
- retrieval planner decisions,
- app-search result count and selected count,
- citation coverage,
- context-too-large failures,
- memory extraction validation failures,
- snapshot invalidations.

Persist per-run assembly data in `chat_prompt_assemblies`. Logs are supporting
telemetry, not the source of truth.

## Acceptance Criteria

### Functional

- A long conversation with more than 100 completed messages no longer sends the
  last 40 messages as the prompt history path.
- The final prompt includes a valid active snapshot when older state exists and
  the snapshot fits the budget.
- The final prompt includes pair-aware recent history after the snapshot
  boundary.
- Conversation memory can answer prior decisions, constraints, and unresolved
  questions after the original turns fall out of recent history.
- Source-grounded memory items include resolvable source refs.
- Exact source questions trigger retrieval or context lookup before final model
  generation.
- Scoped conversations never run unscoped app search.
- Public web search runs only when requested by `web_search` policy.
- UI citations come from persisted message contexts or retrieval rows, not
  model-authored citation text.

### Safety And Correctness

- A source ref that is unreadable, deleted, or stale invalidates dependent
  memory/snapshot state.
- Prompt assembly fails before provider execution if mandatory context cannot
  fit.
- Source-free summaries cannot support source-grounded claims.
- XML prompt rendering escapes every dynamic value inline.
- Message pairs are not split by budget selection.
- Corrections supersede older active memory.
- Provider-native opaque compaction cannot become durable Nexus memory.

### Tests

- Unit tests cover source-ref validation, memory item constraints, snapshot
  coverage, pair-aware history selection, budget allocation, drop reasons,
  context lookup hydration, and prompt rendering.
- Integration tests prove chat runs use `context_assembler` and no longer call
  `load_prompt_history` as the final history policy.
- Scoped chat integration tests prove media/library search scopes remain hard
  boundaries.
- Migration tests prove constraints and indexes.
- Browser tests prove memory/source context UI renders without breaking current
  chat, scope, context-chip, and citation interactions.
- Offline evals include LongMemEval-style cases for extraction, multi-session
  reasoning, temporal reasoning, knowledge updates, and abstention.

### Observability

- Every completed run has one `chat_prompt_assemblies` row.
- The assembly row records snapshot, memory, retrievals, context refs, included
  messages, dropped items, and budget breakdown.
- Failed assembly emits a typed app error and structured diagnostic fields.
- Evals report context precision, context recall, faithfulness, noise
  sensitivity, and tool/context-lookup accuracy.

## Files

### Add

- `docs/chat-context-memory-hard-cutover.md`
  - This spec.

- `migrations/alembic/versions/<next>_chat_context_memory_cutover.py`
  - Add memory, memory source, snapshot, and prompt assembly ledger tables.

- `python/nexus/services/context_assembler.py`
  - Primary chat context assembly service.

- `python/nexus/services/prompt_budget.py`
  - Token budget calculation and lane allocation.

- `python/nexus/services/retrieval_planner.py`
  - Structured retrieval and context-lookup planning.

- `python/nexus/services/context_lookup.py`
  - Unified source-ref and context-ref hydration.

- `python/nexus/services/conversation_memory.py`
  - Memory extraction, merge, supersession, snapshot maintenance, invalidation.

- `python/nexus/schemas/context_memory.py`
  - Source refs, memory items, snapshots, prompt assembly schemas.

- `python/tests/test_context_assembler.py`
  - Assembly, budgets, recent history, snapshots, source refs.

- `python/tests/test_prompt_budget.py`
  - Budget lanes and mandatory/optional drop behavior.

- `python/tests/test_retrieval_planner.py`
  - Query planning and scoped retrieval boundaries.

- `python/tests/test_context_lookup.py`
  - Hydration and permission checks for every supported ref type.

- `python/tests/test_conversation_memory.py`
  - Memory extraction validation, supersession, snapshots, invalidation.

- `python/tests/test_chat_context_memory_cutover.py`
  - End-to-end chat-run behavior after the hard cutover.

- `apps/web/src/components/chat/ConversationMemoryPanel.tsx`
  - Inspect active state coverage and memory source refs.

- `apps/web/src/components/chat/ConversationMemoryPanel.module.css`
  - Panel styling.

- `apps/web/src/__tests__/components/ConversationMemoryPanel.test.tsx`
  - UI coverage.

### Modify

- `python/nexus/db/models.py`
  - Add ORM models and finite enums/check constraints.

- `python/nexus/schemas/conversation.py`
  - Expose memory coverage and assembly-safe source refs where needed.

- `python/nexus/services/chat_runs.py`
  - Replace manual context accumulation and `load_prompt_history` usage with
    `context_assembler`.

- `python/nexus/services/chat_prompt.py`
  - Render typed assembled prompt parts.

- `python/nexus/services/agent_tools/app_search.py`
  - Move ref hydration into `context_lookup`; accept planner output.

- `python/nexus/services/agent_tools/web_search.py`
  - Align refs and retrieval rows with the shared `SourceRef` contract.

- `python/nexus/services/conversations.py`
  - Load memory coverage for conversation reads if UI needs it.

- `python/nexus/api/routes/conversations.py`
  - Add or extend transport-only route for conversation memory inspection if
    needed.

- `apps/web/src/lib/conversations/types.ts`
  - Add memory coverage, memory item, and source-ref types.

- `apps/web/src/components/ConversationContextPane.tsx`
  - Surface conversation state coverage and memory source refs.

- `apps/web/src/components/chat/ChatContextDrawer.tsx`
  - Include memory/state section where drawer is used.

- `apps/web/src/components/chat/MessageRow.tsx`
  - Ensure citations continue to render from backend-owned objects.

### Remove

- `MAX_HISTORY_TURNS` as prompt policy.
- Any direct chat-run prompt path that bypasses `context_assembler`.
- Any local source-ref hydration duplicated outside `context_lookup`.
- Any prompt-size warning that does not enforce the budget.

## Implementation Plan

1. Add schema and migration.
   - Add memory item, memory source, snapshot, and assembly ledger tables.
   - Add ORM models, schemas, finite type aliases, and migration tests.

2. Add source-ref and context-lookup layer.
   - Normalize existing app-search and web-search refs.
   - Move app-search hydration helpers into `context_lookup`.
   - Add permission checks and typed failures.

3. Add prompt budget and context assembler.
   - Implement token budget lanes.
   - Select pair-aware recent history.
   - Load snapshots and memory items.
   - Persist prompt assembly ledgers.
   - Keep final output provider-neutral.

4. Add retrieval planner.
   - Replace app-search string rewriting with structured planner output.
   - Preserve hard scoped retrieval boundaries.
   - Feed planner output into app search, web search, and context lookup.

5. Cut chat runs over.
   - `chat_runs` calls `assemble_chat_context`.
   - Remove direct history loading from the final prompt path.
   - Enforce final prompt budget before provider execution.

6. Add memory extraction and snapshots.
   - Extract typed memory after completed runs.
   - Validate source refs.
   - Supersede contradictions and corrections.
   - Maintain active snapshots.

7. Add UI inspection.
   - Show state coverage and memory refs in existing context UI.
   - Keep chat surface and composer unchanged except for new context data.

8. Add evals and observability.
   - Persist assembly ledgers.
   - Add metrics.
   - Add long-memory regression fixtures.

## Key Decisions

1. Conversation memory is typed state, not a summary.

   A summary is a rendering of state. It is not the durable truth. Durable truth
   is the message log plus typed memory items, snapshots, and source refs.

2. Source refs are first-class.

   A memory item that depends on media or retrieved evidence must point to the
   underlying object. The prompt can carry refs, but source text must be
   retrieved or looked up before supporting factual claims.

3. Prompt assembly is one service.

   Context selection, budget enforcement, retrieval planning, lookup, and prompt
   part ordering belong behind one backend service API. Chat runs stream and
   persist; they do not assemble prompts by hand.

4. Provider compaction is not product memory.

   OpenAI and Anthropic provide useful compaction/context-management features,
   but opaque provider artifacts are not auditable source state. Nexus stores
   provider-neutral memory and may use provider features only as adapter-level
   optimizations after the app has assembled the canonical context.

5. Long context is not a substitute for retrieval.

   Larger windows still degrade with irrelevant or poorly placed context. The
   system must retrieve focused evidence and maintain a small active working
   set.

6. Scopes remain hard boundaries.

   Media and library conversations never fall back to all-library search.
   Retrieval planner output cannot override persisted conversation scope.

7. Corrections supersede.

   Memory is mutable state with audit history. If the user corrects a fact or
   changes a decision, the old memory item becomes superseded instead of
   coexisting as equally active state.

8. Evals are part of the feature.

   Long-memory behavior cannot be reviewed by spot checks alone. The cutover is
   incomplete until regression tests and offline evals cover recall, precision,
   faithfulness, update handling, abstention, and citation coverage.

## Open Questions

- Whether memory extraction runs synchronously for the latest pair when the
  background worker is unavailable, or whether send-time assembly may proceed
  with only already-active memory.
- Whether source-ref invalidation is eager through source mutation hooks or lazy
  during context lookup, or both.
- Whether memory inspection is read-only in this cutover or includes a user
  correction UI.
- Whether provider tokenizers are added in this cutover for every provider, or
  whether conservative estimators are accepted temporarily for non-OpenAI
  providers.
