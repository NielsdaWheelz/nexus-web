# Search Learned Reranker Hard Cutover

**Status:** Provider-rerank route and hardening slice implemented - 2026-06-21

**Type:** Hard cutover. No default learned/provider reranker and no expansion
beyond the private-deep provider-rerank route before eval proof; no silent
deterministic fallback inside a provider-reranked route, no provider SDK bypass,
no unledgered model calls.

## One-Line

Add a learned or provider-backed reranker only after deterministic selection has
measured failure cases, and make it a search-owned, ledgered, budgeted selection
strategy over the same candidate/result contract.

## SME Thesis

A subject matter expert would treat reranking as a measured second-stage
selection strategy, not as a magical relevance upgrade.

The current deterministic selector is valuable because it is local,
inspectable, cheap, stable, and covered by tests. A learned/provider reranker is
justified only when it wins on real retrieval evals after accounting for
latency, cost, privacy, failure modes, and citation precision.

The professional move is:

1. Keep deterministic selection as the baseline strategy.
2. Build eval fixtures that expose deterministic misses.
3. Add a learned/provider rerank mode under search ownership.
4. Send the smallest useful candidate payload.
5. Accept only a closed ordered-id/score output.
6. Ledger every model/provider decision.
7. Fail closed when the reranker route cannot complete.

## Current State

Implemented:

- `search/selection.py` owns deterministic app-search candidate selection.
- It uses hybrid score, lexical exactness, phrase match, result type, citation
  quality, source identity, and section identity.
- `app_search` persists candidate/rerank traces in existing ledgers.
- Retrieval evals measure candidate recall, selected recall, false positives,
  source maps, latency, and noise.
- Public web search uses a separate provider-rank-then-budget strategy.

Remaining gap:

- The default `app_search` route is still deterministic.
- Provider reranking is selected only when the chat run route is eligible for
  private deep retrieval and search policy selects `provider_rerank`.
- Live/provider evals remain an explicit operator lane, not a default test
  dependency.

Implemented in the first slice:

- `search/llm_rerank.py` owns the provider-backed app-search reranker contract:
  compact candidate payloads, strict `app_search_reranker.v1` output validation,
  full candidate-set ranking, closed reason codes, ordinal-only grounding, and
  typed failure mapping.
- Provider calls go through `LedgeredLLM` / `llm_calls` with
  `llm_operation='search_rerank'`; search code does not call raw provider SDKs
  or raw runtime `generate`.
- `app_search` can persist a non-deterministic selection strategy through the
  existing `message_rerank_ledgers` shape. No new telemetry table was added.
- `search/policy.py` records the app-search rerank mode/reason, defaulting to
  deterministic and selecting provider rerank for multi-hop deep retrieval.
- `chat_runs.py` applies provider reranking only when both the persisted chat
  route and the search-owned app-search policy select it.
- Provider-rerank failure rewrites the app-search run as a typed tool error:
  selected evidence is empty, citation materialization has nothing to cite, the
  rerank ledger status is `error`, and the `llm_calls` row remains ledgered.
- Retrieval evals now include an offline fixture-oracle comparison over the
  same candidate set. The fixture records expected top refs and explicitly
  labels the deterministic completed tail as `provider_output_contract_backed:
  false`; strict provider-output coverage lives in the reranker validator tests
  and live eval lane.
- The trust trail renders reranker provider/model/key-mode, call/request ids,
  latency, cost, input/output counts, failure codes, and per-candidate provider
  score/reason trace when the rerank ledger carries them.
- Negative gates prevent reranker contracts from becoming search result types,
  resource capabilities, or direct `app_search` provider-runtime coupling.

Implemented in the hardening slice:

- App-search provider-rerank eligibility is the intersection of chat route
  eligibility and search-owned rerank policy; direct/default app-search routes
  stay deterministic.
- Multi-hop intent survives library, conversation, multi-scope, and
  graph-expanded scope shapes, so provider rerank is not lost by scope
  resolution.
- Provider-rerank candidate rows are persisted as `running` with no selected
  evidence before the provider stage, removing the deterministic completed-row
  crash window.
- Provider-rerank candidates hydrate current `source_map.v1` context for
  `content_chunk` rows before the reranker payload is built; the provider route
  no longer depends on selected-context rendering to see source-map features.
- Generated media summaries are not forwarded as app-search evidence. They may
  remain product/read-model metadata, but the reranker and answer model receive
  concrete source rows only.
- `app_search` and `web_search` require a chat-started, allowed source-policy
  tool-call row and only complete result fields; source boundary policy
  generation and persistence ownership remain in chat-owned files.
- Provider-rerank failures persist the failed call/request metadata in the
  rerank ledger, so the trust trail can show failed provider decisions.
- The trust trail renders persisted `rerank_mode`, `rerank_reason`,
  `context_route`, and `context_route_reason` from app-search rerank ledgers, so
  long-context and provider-rerank route choices are inspectable after readback.
- Prompt assembly replay now fails closed on any immutable prompt-ledger drift,
  not only retrieval-plan drift, so a retried provider-rerank route cannot
  silently send a different prompt under the same plan.
- Interrupted chat finalization marks same-run running tool rows as typed errors
  and repairs unbound provider tool-call SSE events into durable error
  `message_tool_calls`, so pending provider-rerank rows cannot linger as active
  evidence after a provider-output crash.
- Default retrieval evals assert fixture-backed provider comparison, measured
  deterministic actionable misses, measured fixture-oracle improvement, and no live
  `search_rerank` provider calls.
- Provider-rerank private snippet policy is explicit: BYOK is allowed by the
  resolved user key, while platform-key reranking requires platform LLM
  entitlement before any provider call is made or ledgered as allowed.
- Strict provider output is not repaired for `search_rerank`: the first invalid
  closed-output response fails typed, stays ledgered, and forwards no evidence.
- Empty candidate sets do not perform snippet-egress entitlement or BYOK checks,
  because no private snippets leave the app boundary and no provider call runs.
- Provider-rerank metadata is asserted before `message_rerank_ledgers` insert:
  completion requires call ids, provider/model/key mode, cost status, full output
  count, and trace/candidate alignment; error rows require zero selected
  evidence and a failure code.
- Route-disallowed tools persist a blocked `source_policy` with
  `reason="retrieval_plan_disallowed"` even when their source domain would have
  been allowed by source-boundary mixing alone.

## Goals

1. Define the adoption gate for learned/provider reranking.
2. Keep reranking under `python/nexus/services/search/`.
3. Preserve the existing `RetrievalCitation` candidate contract.
4. Preserve candidate/rerank ledger semantics.
5. Use provider/runtime and existing LLM call ledgers for LLM-based reranking.
6. Fail typed when provider reranking is selected and cannot complete.
7. Compare deterministic and learned/provider selection in eval reports.
8. Prevent provider reranking from changing citation identity.

## Non-Goals

- No learned reranker in the default path before eval proof.
- No provider call from `app_search` directly.
- No direct OpenAI/Anthropic/Cohere/Voyage SDK import from search code.
- No hidden deterministic fallback inside a provider-reranked route.
- No generated answer prose from the reranker.
- No reranker-selected citation targets outside existing capability policy.
- No frontend reranking.
- No reranking for live `web_search` in the first slice.

## Default Adoption And Expansion Gate

The provider-rerank route is implemented as a non-default private-deep route.
Default adoption, expansion to new routes, or replacement with another learned
reranker can happen only after all are true:

- deterministic retrieval evals are stable in CI or a focused local gate;
- fixtures include at least five real deterministic misses;
- deterministic baseline metrics are recorded;
- expected provider payload shape is documented;
- token/cost/latency budget is explicit;
- privacy/key-mode policy is explicit;
- failure behavior is typed and tested;
- rerank output can be ledgered per candidate;
- no provider bypass is needed.

The implemented route is selected by the run-level planner plus search-owned
policy. "Behind a route" is not a fallback; it is a closed policy decision.

## Target Behavior

For a deep retrieval route where learned/provider reranking is enabled:

1. App search generates the normal candidate pool.
2. Search builds a compact rerank input from candidate metadata.
3. The reranker returns an ordered list of candidate ordinals with scores and
   short reason codes.
4. Search validates the output strictly.
5. Search applies the returned ordering.
6. Existing packer selects evidence under budget.
7. Existing ledgers record provider/model, latency, cost, input count, output
   count, per-candidate score, per-candidate reason, selected/skipped outcome,
   and citation target quality.

If the reranker route is selected and the provider/model call fails:

- app search returns a typed tool error;
- no selected evidence is forwarded;
- no citations are minted;
- tool/trust trail shows the reranker failure;
- deterministic selection is not silently substituted.

The run-level planner may choose deterministic selection for fast/private/offline
routes. That is a different route, not a fallback after provider failure.

## Reranker Output Contract

The reranker must not produce prose evidence.

Allowed output:

```json
{
  "version": "app_search_reranker.v1",
  "ranked": [
    {"ordinal": 3, "score": 0.98, "reason": "direct_answer"},
    {"ordinal": 0, "score": 0.87, "reason": "supporting_context"}
  ]
}
```

Validation rules:

- `version` must match.
- `ranked` must be a non-empty array.
- every ordinal must be in the input candidate range;
- no duplicate ordinals;
- the first cutover rejects partial output; every input ordinal must appear
  exactly once;
- omitted ordinals are invalid and are not repaired, appended, or silently
  completed;
- scores must be finite numbers in `[0, 1]`;
- reasons must be closed short codes;
- no candidate content, citation target, URI, or body from generated output is
  trusted unless it matches the original candidate ordinal.

## Candidate Payload

Send the minimum useful payload:

- ordinal;
- result type;
- title;
- source label;
- snippet or compact exact text;
- section/path label;
- score features;
- query;
- query class;
- source-map context header when present.

Do not send:

- full document bodies;
- hidden system prompts;
- private unrelated conversation history;
- citation ordinals;
- raw database rows;
- user secrets;
- generated guidance text unless the contextual/hierarchy artifact cutover has
  accepted it as safe guidance.

## Architecture

```text
app_search
  -> search candidate generation
  -> search rerank strategy
       deterministic strategy
       provider strategy through provider_runtime / llm ledger
  -> existing packer
  -> existing tool-call/retrieval/rerank ledgers
  -> chat citation materialization
```

Search owns the strategy choice and candidate ordering. Chat owns whether the
run route allows an expensive/deep retrieval mode.

Provider rerank has two gates:

1. Chat route eligibility: `chat_runs.py` passes provider rerank permission only
   when the persisted retrieval plan route is `private_deep_retrieval`.
2. Search policy eligibility: `plan_app_search` must still select
   `rerank_mode="provider_rerank"` for that app-search run.

The apply stage no-ops unless the app-search run selected provider rerank. A
private-deep route with deterministic app-search policy is a different policy
route, not a fallback after provider failure.

## Provider Runtime Contract

If the reranker uses an LLM:

- use `provider_runtime` through the existing Nexus LLM harness;
- write an `llm_calls` row with operation `search_rerank`;
- preserve provider request id, usage, cost, latency, key mode, and error code;
- validate structured output at the generated-output boundary;
- never call provider SDKs directly from search or app-search code.

If a non-LLM reranker provider is introduced later, it needs an equivalent owner
and ledger. Do not add a one-off HTTP call in `selection.py`.

## Persistence

Keep using `message_rerank_ledgers`.

Metadata additions for provider-reranked runs:

```json
{
  "selection_strategy": "app_search_provider_rerank",
  "selection_policy_version": "v1",
  "baseline_strategy": "app_search_deterministic_selection",
  "provider": "openai",
  "model": "model-name",
  "llm_call_id": "uuid",
  "llm_call_ids": ["uuid"],
  "provider_request_id": "req_123",
  "provider_request_ids": ["req_123"],
  "key_mode_used": "platform",
  "query_class": "cross_document_synthesis",
  "retrieval_mode": "deep",
  "policy_reason": "global_scope",
  "rerank_mode": "provider_rerank",
  "rerank_reason": "multi_hop_deep_retrieval",
  "context_route": "search_then_read",
  "context_route_reason": "long_context_disabled",
  "candidate_limit": 50,
  "selected_limit": 6,
  "rerank_input_count": 50,
  "rerank_output_count": 50,
  "input_tokens": 1234,
  "output_tokens": 100,
  "total_tokens": 1334,
  "latency_ms": 1234,
  "estimated_cost_usd_micros": 123,
  "cost_status": "known",
  "private_snippet_policy": "allowed",
  "private_snippet_policy_version": "app_search_provider_rerank_private_snippets.v1",
  "private_snippet_policy_reason": "platform_llm_entitlement_allows_private_deep_route",
  "candidate_rerank_trace": [],
  "failure_error_code": "E_LLM_TIMEOUT"
}
```

Do not add a parallel rerank telemetry table unless `message_rerank_ledgers`
cannot represent a current required query.

## Evaluation Contract

Eval reports must compare:

- deterministic candidate order;
- provider reranked order;
- deterministic selected pack;
- provider selected pack;
- recall@K;
- MRR;
- NDCG or AP when graded relevance exists;
- selected-pack recall;
- selected false positives;
- citation precision;
- latency;
- token cost;
- provider failures.

Default local evals must not call providers. Use recorded fixture outputs or
fake runtime outputs for default tests. Live/provider evals are a separate
operator-run lane.

Annotated deterministic miss fixtures are allowed in the default gate only when
the measured stage, miss count, and per-fixture thresholds match the fixture.
New or unannotated misses are failures; the fixture threshold is not a fallback
or a widening permission.

## Privacy And Key Mode

Provider reranking sends private saved-source snippets to a model/provider.
That is a product and privacy decision, not an implementation detail.

Rules:

- Platform-key reranking is allowed only if platform policy allows snippets to
  leave the app boundary for this user.
- BYOK mode must use the resolved user key when the run uses BYOK.
- If no allowed key is available for the selected provider-rerank route, the
  tool fails typed.
- The trust trail must show provider/model/key mode, call/request ids, latency,
  cost, input/output counts, failure codes, and per-candidate provider
  score/reason trace at the same abstraction level as other LLM calls.

## Acceptance Criteria

- Provider reranking cannot run until eval fixtures prove deterministic misses.
- Provider rerank calls use provider/runtime or an equivalent approved owner.
- Every provider rerank call is ledgered.
- Reranker output is strictly validated before it changes ordering.
- Provider-reranked runs write `message_rerank_ledgers` with strategy, version,
  provider/model, call id, latency, cost, and per-candidate trace.
- Provider failure in a provider-reranked route produces a typed tool error and
  forwards no evidence.
- Deterministic selector remains available as a separate policy route.
- Default tests and evals do not require network/provider calls.
- Citation targets remain concrete source resources.

## Negative Gates

- No raw provider SDK imports in search/app-search modules.
- No reranker prose in model-facing evidence.
- No generated citation targets from reranker output.
- No silent deterministic fallback after provider reranker failure.
- No provider calls in default retrieval eval tests.
- No route that reranks public web and private app evidence together unless the
  source-boundary policy explicitly allows mixed evidence for that run.

## Files

Backend owners:

- `python/nexus/services/search/policy.py`: `plan_app_search`,
  `AppSearchRetrievalPlan`, and `_query_class` own app-search rerank policy.
- `python/nexus/services/search/selection.py`: `rerank_app_search_candidates`
  and `citation_quality_score` own deterministic baseline ordering.
- `python/nexus/services/search/llm_rerank.py`:
  `rerank_app_search_candidates_with_llm`, `apply_provider_rerank_output`,
  `_candidate_payload`, `_output_error`, `_private_snippet_policy_metadata`,
  and `_rerank_call_metadata` own the provider-rerank contract.
- `python/nexus/services/agent_tools/app_search.py`: `execute_app_search`,
  `apply_provider_rerank_to_app_search_run`, `persist_app_search_run`, and
  `render_retrieved_context_blocks` own the app-search adapter and
  candidate/rerank ledger writes.
- `python/nexus/services/chat_retrieval_plan.py`: `ChatRetrievalPlan`,
  `plan_chat_retrieval`, `evaluate_source_boundary_policy`, and
  `source_domain_for_tool` own run-level routing and source policy.
- `python/nexus/services/chat_runs.py`: app-search dispatch,
  `_tool_ledger_snapshot_event`, `_record_tool_citations`,
  `_app_search_tool_output`, and `prune_tool_call_retrievals` own chat-tool
  orchestration, snapshots, and citation materialization.
- `python/nexus/services/retrieval_citation.py`: `insert_retrieval_row` owns the
  validated `message_retrievals` write path.
- `python/nexus/services/llm_ledger.py`: `LedgeredLLM` owns provider-call
  ledgering.
- `python/nexus/services/message_trust_trails.py`:
  `build_assistant_trust_trails` reads retrieval, candidate, and rerank ledgers.
- `python/nexus/schemas/conversation.py`: transport schemas own strict
  candidate/rerank ledger and SSE snapshot payload validation.
- `python/nexus/db/models.py` and reranker-related migrations own durable table
  shape. Current metadata additions stay in `message_rerank_ledgers`.
- `python/nexus/services/context_assembler.py` and
  `python/nexus/services/chat_run_prompt_tracking.py` own prompt/retrieval-plan
  persistence, not provider-rerank execution.

Likely tests:

- `python/tests/test_search_selection.py`
- `python/tests/test_search_llm_rerank.py`
- `python/tests/test_search_policy.py`
- `python/tests/test_search_retrieval_evals.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_openai_reasoning_contracts.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/components/chat/AssistantMessage.test.tsx`

## Composition With Other Systems

- Run-level planner chooses whether the turn is eligible for expensive/deep
  reranking.
- Source-boundary policy decides whether the candidate set may include public
  and private evidence together.
- Contextual/hierarchy artifacts can provide candidate features, but the
  reranker cannot cite them.
- Provider runtime owns provider capability, key, usage, request-id, and
  structured-output behavior.
- Resource graph remains citation owner.

## Research Notes

Anthropic's Contextual Retrieval writeup reports that reranking after hybrid
retrieval can reduce failed retrievals further, but also calls out latency/cost
tradeoffs. That maps directly to this cutover's eval and budget gates:
`https://www.anthropic.com/engineering/contextual-retrieval`.

Ragas documents retrieval-oriented metrics such as context precision and other
RAG evaluation measures. The important production lesson is to evaluate the
retrieved/selected context separately from final answer style:
`https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/`.

## Verification

Focused first implementation gates:

```bash
cd python && uv run ruff check nexus/services/search/llm_rerank.py nexus/services/search/selection.py nexus/services/agent_tools/app_search.py nexus/services/chat_runs.py nexus/schemas/conversation.py tests/test_search_llm_rerank.py tests/test_agent_app_search.py tests/test_search_retrieval_evals.py tests/test_openai_reasoning_contracts.py tests/test_cutover_negative_gates.py tests/test_migrations.py
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_search_llm_rerank.py tests/test_search_retrieval_evals.py'
./scripts/with_test_services.sh bash -lc 'make _test-back-db-ready >/dev/null && cd python && NEXUS_ENV=test uv run pytest -q tests/test_agent_app_search.py::test_provider_rerank_route_persists_pending_candidates_without_selected_evidence tests/test_agent_app_search.py::test_provider_rerank_policy_requires_chat_route_permission tests/test_agent_app_search.py::test_persist_app_search_run_records_provider_rerank_strategy tests/test_agent_app_search.py::test_render_retrieved_context_does_not_forward_generated_media_summary tests/test_openai_reasoning_contracts.py::test_private_deep_app_search_uses_provider_rerank_route tests/test_cutover_negative_gates.py::test_chat_run_events_check_is_new_stream_grammar_only'
cd apps/web && bun run typecheck && bun run test:unit -- src/lib/api/sse/events.test.ts && bun run test:browser -- src/components/chat/useChatMessageUpdates.test.tsx src/components/chat/AssistantMessage.test.tsx
```

Optional live-provider lane, skipped when live-provider secrets are absent:

```bash
make test-search-rerank-live-evals
```
