# Search Run-Level Planner Hard Cutover

**Status:** Implemented and provider-start hardened - 2026-06-21

**Type:** Hard cutover. No legacy planner path, no request-level routing knobs,
no hidden retrieval, no fallback from runtime policy to prompt-only guidance.

## One-Line

Make chat compute and persist one run-level retrieval plan before provider
execution, then use that plan to constrain attached-context, `app_search`,
`inspect_resource`, `read_resource`, `web_search`, and long-context routing.

## SME Thesis

A subject matter expert would not ask "how do we make `app_search` smarter?"
The expert question is:

> Which evidence path should this turn use, and which owner is allowed to make
> that decision?

The current system already has good per-tool owners:

- Search owns `SearchQuery`, candidate policy, deterministic selection, and
  retrieval evals.
- Chat owns provider orchestration, prompt assembly, tool dispatch, prompt
  budget, citations, SSE, and tool-call ledgers.
- Resource graph owns `ResourceRef`, context refs, citations, and graph-derived
  scope expansion read models.
- Content indexing owns source-derived chunk/source-map read models.

The missing owner is the chat run's route decision across those tools. That
decision must be explicit, deterministic for the first slice, persisted for
trust trails, and enforced before any tool forwards evidence to the model.

The professional shape is a small chat-owned planner. It decides the route for
the turn; it does not execute search, read resources, inspect documents, query
graph rows, rank candidates, or mint citations.

## Current State

Implemented foundation:

- `search/policy.py` owns `plan_app_search`, a deterministic app-search policy
  classifier for query class, candidate depth, retrieval mode, policy reason,
  and private context route.
- `chat_prompt.py` tells the model when to use context, app search, inspect,
  read, and web search.
- `chat_runs.py` executes model-requested tools, enforces aggregate tool-output
  budget, persists ordered tool calls, and materializes citations.
- `read_resource` and `inspect_resource` admit resources selected by app search
  in the same assistant message.
- `app_search` ledgers query class, candidate depth, rerank trace, graph
  expansion, source maps, context route, selected count, and more-available
  state.
- `chat_retrieval_plan.py` owns the chat-run retrieval plan, source-domain
  route, tool allowlist/blocklist, deterministic query class, and explicit
  saved-source/web mix classifier.
- `chat_runs.retrieval_plan` stores one run-owned `chat_retrieval_plan.v1`;
  prompt assembly validates against that plan, and the trust trail renders the
  route, policy, allowed/blocked tools, candidate sequence, context/scope
  counts, budget policy, and reason.
- `chat_runs.py` sends only planner-allowed tools to the provider and persists
  disallowed provider tool calls as typed errors before execution.
- The private/web classifier treats bare `public` and private-source `news`
  wording as private context unless the user explicitly names public web/source
  intent.

Hardened after audit:

- Prompt assembly persistence locks any existing `chat_prompt_assemblies` row and
  defects if any immutable prompt assembly field differs from the stored row, so
  replay/resume cannot silently execute a divergent route or prompt ledger.
- Context assembly now plans from metadata-only subject/context-ref/selection
  inputs before rendering private subject, selection, branch-anchor, resource
  body, or attached-citation blocks.
- The shared `llm_calls` owner inserts one `started` row before the provider call
  opens and updates that same row to `succeeded` or `failed`; chat streaming
  commits the start row before opening the provider stream.
- `ChatRetrievalPlan` now enforces closed route/source/mixing/query/tool
  vocabularies at construction.
- Blocked source-policy tool batches persist all attempted tool rows before
  compact error-output budget checks.
- Chat persists and streams a first-class `retrieval_plan` run event
  immediately after plan persistence; live SSE folds the same strict plan shape
  into `trust_trail.run.retrieval_plan`.
- Interrupted chat finalization repairs unbound provider tool-call SSE events
  into durable error tool rows and marks pending/running tool plus rerank ledger
  rows as `interrupted_before_tool_result`.

## Goals

1. Add one chat-owned run-level planner for retrieval route selection.
2. Decide whether the turn should answer from attached context, use private
   local search, inspect a document map, read exact evidence, use long-context
   private reading, use public web, or block a mixed-source route.
3. Keep `plan_app_search` as search-owned per-tool retrieval policy.
4. Keep app search as a tool adapter and telemetry writer.
5. Keep citation materialization in chat/resource graph.
6. Persist the plan once per chat run so trust trails can explain why tools were
   exposed, blocked, or expected.
7. Add tool-call accuracy fixtures before introducing a model-based planner.
8. Make broad/multi-hop/local/global/absence routes inspectable and testable.

## Non-Goals

- No model-based planner in the first implementation slice.
- No new `/chat-runs` request fields such as `web_search`, `context_route`,
  `conversation_scope`, `retrieval_mode`, or `long_context_route`.
- No tool-argument fields that bypass existing schemas.
- No hidden prefetch whose body is forwarded to the model without a visible
  tool call or attached-context ledger.
- No direct `resource_edges` queries from `app_search`.
- No search-specific scope grammar inside chat planner.
- No promotion of `message_retrievals`, `source_map.v1`, or planner metadata
  into citation identity.
- The planner must always emit a closed route. Ambiguous-but-anchored input
  falls through to the `private_app_search` route with reason
  `default_private_search_or_context` and exposes only the safe default private
  tools; a bare deictic with no anchor maps to `clarify_scope`, and empty input
  maps to `no_retrieval`. `default_private_search_or_context` is a reason code,
  not a route intent.

## Target Behavior

Every chat run gets exactly one retrieval plan before the first provider call.

The planner classifies the user turn into one of these route intents:

- `answer_from_attached_context`
- `private_app_search`
- `private_inspect_then_read`
- `private_exact_read`
- `private_long_context_read`
- `private_deep_retrieval`
- `public_web_search`
- `explicit_private_public_comparison`
- `clarify_scope`
- `no_retrieval`

The planner records:

- `version`
- `route_intent`
- `source_domain`
- `mixing_policy`
- `query_class`
- `allowed_tools`
- `blocked_tools`
- `candidate_tool_sequence`
- `internal_tool_sequence`
- `reason`
- `context_ref_count`
- `search_scope_count`
- `search_scope_uris`
- `budget_policy`

The planner affects runtime behavior:

- If attached context is enough, tools remain available only when the route
  allows follow-up retrieval; the prompt gets a compact plan note.
- If local search is needed, `app_search` is available and web search is not,
  unless the source-boundary policy explicitly allows mixed public/private
  research.
- If exact wording from an already referenced readable resource is needed,
  `read_resource` is available and `app_search` is not required.
- If a long media document is referenced and the question needs structure,
  `inspect_resource` is available before exact reads.
- If a single-media whole-source request is explicit, the existing private
  long-context route remains available through `app_search` and `read_resource`.
- If the user asks for current outside information, `web_search` is available
  and private app tools are not, unless the request explicitly asks to compare
  saved sources with the web.
- If the model requests a tool disallowed by the run plan, chat persists a
  blocked tool-call row and returns a typed tool error without executing the
  tool.

## Architecture

```text
chat run
  -> assemble context snapshot
  -> plan run retrieval route
  -> persist run retrieval plan
  -> persist prompt assembly
  -> build provider request with allowed tools and plan prompt note
  -> execute tool batches through chat-owned dispatch gates
       app_search -> search policy/candidate/rerank/packer owners
       inspect_resource -> media_read_map owner
       read_resource -> resolver/media_read_map owner
       web_search -> public web-search owner
  -> persist retrieval/tool/citation ledgers
  -> render trust trail from persisted state
```

### Owner Map

Chat owns:

- run-level route classification;
- allowed tool set for the provider turn;
- blocked-tool-call persistence;
- aggregate tool-output budget;
- citation numbering;
- trust-trail route explanation.

Search owns:

- app-search query class and candidate count through `plan_app_search`;
- hybrid candidate generation;
- deterministic or future learned reranking;
- retrieval evals.

Resource graph owns:

- context refs;
- citation edges;
- graph-derived scope expansion read models.

Content indexing owns:

- current source-derived `source_map.v1`;
- future contextual/hierarchy guidance read models.

## Planner Input Snapshot

The planner consumes owned same-system data, not raw HTTP payloads:

- current user message text;
- conversation context ref URIs;
- chat subject ref URI, if any;
- whether a reader selection is present;
- whether a public web provider is configured;

The planner must not query provider state, execute search, read document bodies,
inspect prompt blocks, consume token budgets, or call an LLM.

## Planner Output Contract

Use a small closed shape. A dict is acceptable at persistence boundaries, but
internal code should use a narrow typed value until the final database write.

Required fields:

```json
{
  "version": "chat_retrieval_plan.v1",
  "route_intent": "private_app_search",
  "source_domain": "private_app",
  "mixing_policy": "single_domain",
  "query_class": "cross_document_synthesis",
  "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
  "blocked_tools": ["web_search"],
  "candidate_tool_sequence": ["app_search", "inspect_resource", "read_resource"],
  "internal_tool_sequence": [],
  "reason": "broad_saved_source_question",
  "context_ref_count": 3,
  "search_scope_count": 2,
  "search_scope_uris": [
    "library:11111111-1111-1111-1111-111111111111",
    "media:22222222-2222-2222-2222-222222222222"
  ],
  "budget_policy": "tool_output_budget_from_prompt_assembly"
}
```

Closed vocabularies belong in the chat planner module. Do not let frontend code
infer route state from tool names or scope strings.

## Persistence And Trust Trail

Persist the plan once per run.

Preferred shape:

- Add a narrowly named `retrieval_plan` JSONB column to `chat_runs`.
- Backfill historical runs to a complete closed-vocabulary
  `chat_retrieval_plan.v1` object with `route_intent: "no_retrieval"`,
  `source_domain: "none"`, all tools blocked, and `reason: "pre_cutover"`.
- After the cutover, every executable run persists a complete v1 plan before
  prompt assembly and before any provider call.
- Prompt assembly asserts the persisted run plan matches the in-memory assembly
  plan, but does not duplicate it.

Do not add a new planner table for the first slice. The plan is run-owned: it
explains which retrieval route and tool surface the run selected. Prompt
assembly owns the prompt budget and block manifest only.

Trust trail should show:

- route intent;
- source domain;
- allowed tools;
- blocked tools, when present;
- internal tool sequence, when chat performs synthetic owner-layer reads;
- reason;
- whether tool calls followed or violated the plan.

## Tool Policy

Allowed tools are derived from the route, not from user request fields.

| Route intent | Allowed tools |
|---|---|
| `answer_from_attached_context` | none |
| `private_app_search` | `app_search`, `inspect_resource`, `read_resource` |
| `private_inspect_then_read` | `inspect_resource`, `read_resource`, optional `app_search` |
| `private_exact_read` | `read_resource`, optional `inspect_resource` |
| `private_long_context_read` | `app_search`, internal private `read_resource` path |
| `private_deep_retrieval` | `app_search`, `inspect_resource`, `read_resource` |
| `public_web_search` | `web_search` |
| `explicit_private_public_comparison` | `app_search`, `inspect_resource`, `read_resource`, `web_search` |
| `clarify_scope` | none |
| `no_retrieval` | none |

Referenced-resource reading is classified as `private_exact_read` or
`private_inspect_then_read`, not as `answer_from_attached_context`.

If provider tool definitions are built per run, only allowed tools are sent to
the provider. If a provider still returns a disallowed tool call, chat persists a
blocked tool call and returns a typed error result.

## Query Classes

The run-level planner may reuse the query-class vocabulary from
`search/policy.py`, but the ownership is different:

- run-level planner query class: decides the tool route;
- app-search policy query class: decides app-search depth and mode.

Keep the vocabularies aligned in tests, but do not make chat import private
search heuristics unless `search/policy.py` exposes a public classifier for this
purpose.

## API Design

No public API request change.

`POST /chat-runs` remains the single chat-run creation endpoint. User controls
retrieval by ordinary language and attached context, not by product-internal
planner fields.

Internal API shape:

```python
plan_chat_retrieval(
    *,
    user_text: str,
    context_ref_uris: Sequence[str],
    subject_ref: str | None,
    reader_selection_present: bool,
    web_search_available: bool,
) -> ChatRetrievalPlan
```

This helper belongs to chat. Extract it from `chat_runs.py` only if the tests
and call site are clearer with a small module such as
`python/nexus/services/chat_retrieval_plan.py`.

## Evaluation Contract

Add a tool-call accuracy fixture set before changing provider behavior broadly.

Fixture fields:

- user prompt;
- context refs summary;
- expected route intent;
- expected source domain;
- allowed tools;
- forbidden tools;
- expected first tool when a tool is required;
- notes for exact-read, inspect-first, absence, public web, and mixed routes.

Metrics:

- route accuracy;
- forbidden-tool false positive rate;
- unnecessary-tool rate for attached-context questions;
- missed-retrieval rate for questions requiring tools;
- blocked-tool precision;
- latency overhead of planning;
- trust-trail completeness.

The fixture should include:

- attached highlight answerable without tools;
- referenced media requiring exact read;
- long media requiring inspect before read;
- broad saved-source synthesis;
- absence question over saved sources;
- public current-events question;
- explicit saved-source versus web comparison;
- ambiguous "this" with no subject;
- single-media whole-source summary;
- multi-hop search/read/inspect question.

## Acceptance Criteria

- Every new chat run persists exactly one `chat_retrieval_plan.v1`.
- Provider tool definitions are constrained by the run plan.
- Disallowed tool calls are blocked before tool execution.
- Blocked calls are persisted as tool calls with typed errors and no retrieval
  rows.
- Tool-call accuracy fixtures pass for representative route classes.
- Existing `app_search` planner metadata remains search-owned and visible in
  rerank ledgers.
- Trust trail shows run route, allowed tools, blocked tools, and policy reason.
- Broad app-search, long-context, graph-expansion, citation, and budget tests
  continue to pass.

## Negative Gates

- No new `/chat-runs` planner fields.
- No `app_search` tool args for route, long-context mode, source domain, or web
  policy.
- No direct graph SQL in `app_search`.
- No hidden evidence body in the provider prompt outside attached context or a
  visible tool result.
- No model-based planner code until deterministic fixtures exist.
- No fallback path that executes a disallowed tool after planner failure.

## Files

Likely backend files:

- `python/nexus/services/chat_runs.py`
- `python/nexus/services/chat_prompt.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/chat_retrieval_plan.py` if extraction earns its keep
- `python/nexus/services/message_trust_trails.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- one Alembic migration for `chat_runs.retrieval_plan`

Likely tests:

- `python/tests/test_chat_retrieval_plan.py`
- `python/tests/test_openai_reasoning_contracts.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_policy.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/lib/api/sse/events.test.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.test.tsx`
- `apps/web/src/components/chat/AssistantMessage.test.tsx`

## Composition With Other Remaining Slices

- The source-boundary cutover consumes the run plan's `source_domain` and
  `mixing_policy`.
- The contextual/hierarchy artifact cutover can add planner features, but the
  planner should only consume its typed read model.
- The learned-reranker cutover stays under search selection; the run planner
  may choose a retrieval mode but must not call the reranker directly.

## Research Notes

OpenAI Deep Research describes agentic multi-step research with visible tool
calls, citations, background execution, and `max_tool_calls` as a cost/latency
constraint. The relevant product lesson for Nexus is not to copy a provider
product; it is to make tool routing, tool-call limits, and citations explicit:
`https://developers.openai.com/api/docs/guides/deep-research`.

## Verification

Focused first implementation gates:

```bash
cd python && NEXUS_ENV=test uv run pytest -q tests/test_chat_retrieval_plan.py
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_openai_reasoning_contracts.py tests/test_chat_runs.py tests/test_agent_app_search.py tests/test_cutover_negative_gates.py'
cd apps/web && bun run test:unit -- src/lib/api/sse/events.test.ts
cd apps/web && bun run test:browser -- src/components/chat/useChatMessageUpdates.test.tsx src/components/chat/AssistantMessage.test.tsx
```
