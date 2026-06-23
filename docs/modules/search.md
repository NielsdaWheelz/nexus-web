# Search And Retrieval Module

**Status:** Draft architecture contract, 2026-06-20.

## Scope

The search module owns local-library retrieval for the search page, palette search,
chat `app_search`, and any future retrieval controller that selects evidence from
Nexus-owned resources.

Backend owners live under `python/nexus/services/search/`,
`python/nexus/services/content_indexing.py`,
`python/nexus/services/note_indexing.py`, and the chat adapter
`python/nexus/services/agent_tools/app_search.py`.

Frontend owners live under `apps/web/src/lib/search/*`,
`apps/web/src/app/(authenticated)/search/*`, and palette callers that consume the
shared search query model.

Search does not own citation identity. Citations are graph-owned
`resource_edges`; `message_retrievals` and retrieval ledgers are telemetry.

## Current Architecture

One shared `search(db, viewer, SearchQuery)` serves the search page and chat
`app_search`. The edge parses transport into a strict `SearchQuery`; internal
callers do not pass raw HTTP params or tool args inward. Note object-ref lookup is
an adjacent object-ref service, not part of the shared `SearchQuery` path.

Retrieval is already hybrid. For semantic-capable result types, search builds one
query embedding, retrieves candidates from vector ANN and lexical FTS, applies
type weighting and per-type normalization, sorts deterministically, and paginates
to the requested result limit. The shared tuning constants currently include:

- `DEFAULT_LIMIT = 20`
- `MAX_LIMIT = 50`
- `CANDIDATES_PER_TYPE = 200`
- `CONTENT_CHUNK_MIN_ANN_CANDIDATES = 200`
- `CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER = 20`
- `CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY = 0.50`

Multi-scope execution lives in `search/batch.py`: each scope is searched through
the shared `SearchQuery`, results are deduped by `(type, id)`, the best score is
kept, and the merged list is capped by the base query limit.

The current chat bottleneck is not the shared search substrate. It is
`app_search` candidate policy plus evidence selection:

- `APP_SEARCH_SCOPED_CANDIDATE_LIMIT = DEFAULT_LIMIT` (`20`)
- `APP_SEARCH_DEEP_CANDIDATE_LIMIT = MAX_LIMIT` (`50`)
- `APP_SEARCH_SELECTED_LIMIT = 6`
- `APP_SEARCH_CONTEXT_CHARS = 16000`
- `execute_app_search` resolves conversation scopes, asks `search/policy.py` for
  the query class, candidate limit, retrieval mode, and policy reason, then
  builds the shared `SearchQuery`.
- The first runtime policy uses a moderate candidate pool for a single `media:`
  scope and the public max candidate pool for library, conversation, multi-scope,
  and global searches.
- Runtime policy metadata is stored in `message_rerank_ledgers.metadata`:
  deterministic selection strategy/version, ordering policy, diversity policy,
  budget policy, candidate limit, selected limit, context budget, scope count,
  actual candidate result-type mix, query class, retrieval mode, policy reason,
  bounded scope label, full resolved scope list, inclusion surface, selection
  reason counts, and a per-candidate rerank trace with selected/skipped pack
  outcomes.
- Query-class metadata comes from the search-owned deterministic
  `plan_app_search` policy. It classifies obvious exact, scoped, synthesis,
  global, multi-hop, absence, and recency/conversation questions before the
  later retrieval-controller layer exists.
- `search/selection.py` reranks app-search candidates deterministically before
  packing. It uses hybrid score, lexical exactness, phrase match, result type,
  citation quality, source identity, and locator-derived section identity. Exact
  phrase matches retain low diversity pressure; broad non-phrase matches apply
  source/section penalties even when they contain every query term.
- `render_retrieved_context_blocks` packs rendered blocks under the char budget,
  skips empty/oversized candidates, and keeps an ordinal-aligned decision reason
  for every candidate.
- Current `app_search` packer reasons are `selected_within_budget`,
  `skipped_over_budget`, `skipped_empty_render`, `skipped_uncitable`, and
  `skipped_selected_limit`. Provider-rerank adapter outcomes use
  `skipped_provider_rerank_pending` and `skipped_provider_rerank_failed`; those
  are provider-route states, not ordinary packer decisions. Oversized evidence
  is skipped rather than trimmed; deeper exact-read and summarization policies
  belong to the later retrieval-controller layer.
- `message_rerank_ledgers.strategy` records the active selector. The default
  selector remains `app_search_deterministic_selection`; provider rerank runs
  use `app_search_provider_rerank` and still write the same ledger shape.
- The model-facing tool continuation is compact selected-result JSON from
  `_app_search_tool_output`, not the full rendered `context_text`.
- Selected `content_chunk` results can include compact `source_map.v1` guidance
  derived by `content_indexing` from current chunk/block/span rows. The map
  exposes owner, source revision, read/evidence URIs, section path, context
  header, and part count; it is not a citation target.
- Persisted `web_result` rows are renderable app-search evidence; live public web
  search still belongs to the separate `web_search` tool.
- Public `web_search` writes the same rerank ledger table with
  `provider_rank_then_context_budget` metadata, provider-rank ordering, selected
  limit, context budget, reason counts, and per-candidate pack outcomes.
- Trust-trail read models infer `included_in_prompt_source = "tool_output"` from
  selected retrieval rows plus rerank metadata `inclusion_surface = "tool_output"`
  so model-visible tool evidence is not confused with initial prompt assembly.

This means the system can retrieve from a decent hybrid substrate, select a more
balanced deterministic evidence pack, and expose current-index source-map
guidance for selected chunks. Omitted-scope broad queries can use graph-derived
scope expansion through the resource graph owner. Broad questions can decompose
into several visible `app_search` calls through the chat tool loop. Explicit
single-media whole-source queries can privately route through chat-owned
long-context execution with normal read citations; if a body cannot be cited, it
is not forwarded as evidence. The private/public web boundary is a chat-owned
runtime source policy: same-run private/public tool evidence is blocked before
adapter execution unless the planner classified an explicit saved-source/public
web comparison. The system still needs later generated contextual summaries, a
real generated-guidance owner/job, comparative eval proof, and default adoption
of the learned/provider reranker route.

## Ownership Boundaries

Search owns:

- `SearchQuery`, kind/filter parsing, validation, and result-type expansion.
- Scope parsing, authorization, and scope-to-entity SQL.
- Hybrid candidate generation, ranking, reranking policy, and candidate/result
  count policy.
- The provider-rerank output contract and ordinal-to-candidate grounding for
  app-search reranking.
- Search result projection into `SearchResultOut` and `RetrievalCitation`
  inputs.
- Retrieval quality evaluation for local-library search.

Chat owns:

- Conversation context-ref admission for tool scopes.
- Tool-call execution, retries, SSE events, and provider loop orchestration.
- Chat-specific evidence packing, prompt-budget tradeoffs, and retrieval ledgers.
- Mapping selected retrieval telemetry rows to graph citation edges through the
  chat-run citation owner.

Resource graph owns:

- `ResourceRef` identity.
- Context refs, citation edges, and connection edges.
- `CitationOut` read models and target-resource activation.

Content indexing owns:

- `content_blocks`, `evidence_spans`, `content_chunks`, embeddings, and
  `content_index_states`.
- Owner-polymorphic reindexing for media and notes.
- Active embedding provider/model gating.

`app_search` must stay a chat adapter and telemetry writer. It must not become a
private vector store, private graph query engine, private citation owner, or
second search semantics layer.

## Query Classes

Retrieval policy should classify queries before choosing depth:

- Exact lookup: title, person, phrase, citation, date, or identifier.
- Local passage lookup: "where does this concept appear?"
- Scoped document lookup: a question about a known media/library ref.
- Cross-document synthesis: compare, trace, find patterns, or summarize across
  sources.
- Global sensemaking: "what do my sources say about X?"
- Multi-hop retrieval: answer requires a sequence of lookup, inspect, read, and
  follow-up search.
- Negative/absence questions: "do any sources mention X?"
- Recency/continuity questions over conversations or notes.

Small top-k is least appropriate for cross-document, global, multi-hop, and
absence questions. Those should select deeper candidate pools and use iterative
tooling.

## Gold-Standard Retrieval Controller

The target architecture is a staged retrieval controller. The stages are explicit
so they can be evaluated and ledgered independently.

1. Query planning
   - Normalize the user request.
   - Detect query class.
   - Decompose broad questions into subqueries when useful.
   - Choose scope, candidate depth, rerank mode, and evidence budget.

2. Candidate generation
   - Use the shared hybrid search substrate.
   - Over-retrieve candidates for quality-sensitive modes.
   - Keep lexical, semantic, scope, type, recency, and locator metadata.
   - Separate candidate count from selected evidence count.

3. Reranking
   - Start with deterministic rerank features: hybrid score, lexical exactness,
     source type, owner diversity, section proximity, recency, and citation
     usefulness.
   - Add MMR/diversity to avoid one source or one section crowding out the pack.
   - Add a cross-encoder or LLM reranker behind the same interface only after
     deterministic evaluation exists.

4. Evidence packing
   - Select evidence under a real token budget, not only a char budget.
   - Current foundation behavior skips oversized blocks instead of breaking the
     pack; trim/summarize requires a separate owner, ledger vocabulary, and
     tests.
   - Apply per-source and per-section quotas.
   - Prefer exact passage evidence over container rows.
   - Return "more available" metadata so the model can ask for additional
     retrieval or exact reads.

5. Exact read and inspect follow-up
   - Use `inspect_resource` for document maps and `read_resource` for exact
     passages after search identifies promising sources.
   - Treat search as candidate discovery; treat reads as final evidence when a
     question depends on precise wording.

6. Citation materialization
   - Selected, citable evidence becomes citation edges through chat-run citation
     ownership.
   - `message_retrievals` and candidate/rerank ledgers remain telemetry.

## Foundation Cutovers

The initial retrieval-controller foundation was split into five hard cutovers.
Each cutover should be independently reviewable, testable, and revertible.

1. [`search-retrieval-evals-hard-cutover.md`](../cutovers/search/search-retrieval-evals-hard-cutover.md)
   - Build golden query fixtures and retrieval evals before changing runtime
     behavior.
   - Measure candidate recall, ranking, selected-pack recall, citation precision,
     latency, and cost.

2. [`search-evidence-packer-ledger-hard-cutover.md`](../cutovers/search/search-evidence-packer-ledger-hard-cutover.md)
   - Fix deterministic packer correctness.
   - Skip oversized blocks, continue to later candidates, and ledger every
     selection decision.

3. [`search-candidate-policy-hard-cutover.md`](../cutovers/search/search-candidate-policy-hard-cutover.md)
   - Separate candidate depth from selected evidence depth.
   - Replace the old single `APP_SEARCH_LIMIT = 8` cap with explicit moderate
     and deep candidate policies through shared `SearchQuery`.

4. [`search-rerank-selection-hard-cutover.md`](../cutovers/search/search-rerank-selection-hard-cutover.md)
   - First deterministic selector slice implemented before learned/provider
     rerankers.
   - Selects evidence by relevance, exactness, source/section diversity,
     citation quality, and prompt budget.

5. [`search-agentic-contextual-retrieval-hard-cutover.md`](../cutovers/search/search-agentic-contextual-retrieval-hard-cutover.md)
   - Add deep retrieval after the foundation is measured and stable.
   - Cover query planning, iterative search/inspect/read, contextual chunks,
     hierarchy/graph retrieval, and long-context routing.

## Follow-Up Hard-Cutover Specs And Status

After the foundation, these hard-cutover specs were split out. Some are now
implemented; each spec owns its exact status and remaining gaps:

1. [`search-run-level-planner-hard-cutover.md`](../cutovers/search/search-run-level-planner-hard-cutover.md)
   - Implemented chat-owned route planning and plan-before-private-body
     rendering; hardened with a committed `llm_calls.call_status='started'`
     row before chat provider stream open.

2. [`search-source-boundary-policy-hard-cutover.md`](../cutovers/search/search-source-boundary-policy-hard-cutover.md)
   - Implemented same-run runtime public/private tool-evidence enforcement;
     remaining boundary is historical-message source classification, if product
     scope expands beyond same-run tool evidence.

3. [`search-contextual-hierarchy-artifacts-hard-cutover.md`](../cutovers/search/search-contextual-hierarchy-artifacts-hard-cutover.md)
   - First source-map retrieval slice implemented; remaining work is real
     generated contextual summaries, hierarchy jobs, owner consumption, and
     comparative eval proof.

4. [`search-learned-reranker-hard-cutover.md`](../cutovers/search/search-learned-reranker-hard-cutover.md)
   - Provider-rerank route implemented behind planner/search policy gates;
     remaining work is default adoption only after live/operator eval proof.

## External Retrieval Patterns And Product Meta

These are external retrieval patterns and product targets, not implementation
claims or eval proof for every Nexus route. The practical state of the art is
not "bigger top-k" alone. It is measured, multi-stage retrieval:

- Hybrid sparse+dense retrieval generally beats embeddings alone.
- Retrieval systems often feed a reranker with tens or hundreds of candidates,
  then pass a smaller selected set to the model.
- Contextual chunk headers improve chunk-level recall by preserving document
  context at index time.
- Rerankers trade runtime cost and latency for better selected evidence.
- Agentic RAG treats retrieval as iterative and state-dependent, not as a single
  preprocessing step.
- Graph and hierarchy approaches help most on global, cross-document, and
  multi-hop questions where flat chunk retrieval loses structure.

Useful external baselines:

- Anthropic Contextual Retrieval:
  `https://www.anthropic.com/engineering/contextual-retrieval`
- Claude contextual retrieval cookbook:
  `https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide`
- Azure AI Search hybrid retrieval and semantic reranking:
  `https://learn.microsoft.com/en-us/azure/search/hybrid-search-how-to-query`
- OpenAI File Search retrieval customization:
  `https://developers.openai.com/api/docs/guides/tools-file-search`
- OpenAI Deep Research:
  `https://developers.openai.com/api/docs/guides/deep-research`
- LlamaIndex retrieval evaluation:
  `https://developers.llamaindex.ai/python/examples/evaluation/retrieval/retriever_eval/`
- Ragas metrics:
  `https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/`
- Agentic RAG survey:
  `https://arxiv.org/html/2506.10408v1`
- Long-context vs RAG routing:
  `https://arxiv.org/html/2407.16833v1`
- Long-context RAG hard negatives:
  `https://openreview.net/forum?id=oU3tpaR8fm`
- Graph/hierarchical RAG research space:
  `https://arxiv.org/html/2505.24226v2`
  `https://arxiv.org/html/2506.05690v2`
- Gemini long-context docs:
  `https://ai.google.dev/gemini-api/docs/long-context`
- NotebookLM product/user signals:
  `https://support.google.com/notebooklm/answer/16269187`
  `https://support.google.com/notebooklm/answer/16179559`

For Nexus, the one-user prototype constraint should bias toward quality and
observability over low-latency enterprise defaults. It is acceptable to spend more
tokens and seconds for "deep retrieval" modes, as long as ordinary searches keep a
fast path and every retrieval decision is inspectable.

## Horizon

The expected direction is not one giant context window replacing retrieval.
Long-context models will keep improving, but retrieval remains useful for cost,
privacy, focus, provenance, source control, and inspectable evidence.

Near term:

- hybrid sparse+dense search, contextual chunks, reranking, and retrieval evals
  become table stakes
- deep-research products normalize search/fetch/read loops with citations
- user-facing research tools increasingly discover sources instead of only using
  uploaded files

Mid term:

- personal systems maintain source maps, concept graphs, and user-specific
  ranking signals
- retrieval policy routes between fast RAG, deep retrieval, and long-context
  reading
- trust trails expose not only citations, but searched scope, skipped evidence,
  contradictions, and confidence

Long term:

- retrieval becomes a persistent memory substrate across reading, notes, chat,
  search, and research
- evidence graphs become versioned, user-specific models of a library or project
- context windows are huge, but selected evidence still matters because users
  need controllable, reviewable provenance

## Evaluation Contract

Retrieval changes must be eval-driven. A candidate-generation or reranking change
is not complete because one answer "looks better."

Minimum offline metrics:

- Recall@K for candidate pools.
- MRR for first relevant result.
- Precision@K for noisy query classes.
- NDCG or AP when graded relevance exists.
- Evidence-pack recall: relevant items included in the final selected context.
- Citation precision: cited resources support the generated claim.
- Latency and token cost by retrieval mode.

Minimum datasets:

- Exact lookup queries.
- Single-document passage queries.
- Multi-document synthesis queries.
- Global library questions.
- Multi-hop read/inspect/search questions.
- Negative/absence questions.
- Scoped media/library queries.

Next dataset to add:

- Regression examples from real failed chat turns.

The eval harness should replay candidate generation, rerank, and pack stages
separately so the failure point is visible.

## Trust Trail And Ledgers

The durable observability model should show:

- Tool call inputs and normalized search query.
- Candidate pool size, score features, and source metadata.
- Rerank strategy and score/reason for each candidate.
- Selection state: selected, skipped, duplicate, over-budget, low-rank,
  low-diversity-value, unsupported, or uncitable. Future trim/summarize states
  require their own runtime owner and tests before they enter this ledger
  vocabulary.
- Prompt inclusion state for tool-output evidence as well as initial prompt
  assembly evidence.
- Citation edge backpointers for cited selected evidence.
- Implemented `more_candidates_available` boolean on tool-result read models.
- Future richer "more available" counts by scope/source/type.

`message_retrieval_candidate_ledgers` and `message_rerank_ledgers` are the right
substrate. The current app-search selector records strategy metadata, selection
reason counts, a per-candidate rerank trace, and the coarse
`more_candidates_available` boolean; future retrieval-controller work should add
exact-read follow-up and richer "more available" count semantics before
higher-risk retrieval changes.

## What Not To Do

- Do not fix retrieval by only increasing candidate caps.
- Do not move search semantics into `app_search`.
- Do not query `resource_edges` directly from `app_search`; use graph context
  admission and shared search scope owners.
- Do not promote `message_retrievals` to citation identity.
- Do not bypass `SearchQuery` with tool-specific typed IDs or private filters.
- Do not default-adopt, expand, or replace the current provider-rerank route
  before there is eval proof and a deterministic baseline.
- Do not hide retrieval failures behind summaries; expose skipped/available
  evidence and reasons in the trust trail.

## Contract Tests

Keep these tests aligned with the module contract:

- `python/tests/test_search.py`
- `python/tests/test_search_kinds.py`
- `python/tests/test_search_retrieval_evals.py`
- `python/tests/test_search_intent_model_guards.py`
- `python/tests/test_search_scope_matrix.py`
- `python/tests/test_search_batch.py`
- `python/tests/test_search_llm_rerank.py`
- `python/tests/test_search_policy.py`
- `python/tests/test_chat_retrieval_plan.py`
- `python/tests/test_source_boundary_policy.py`
- `python/tests/test_content_indexing.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_openai_reasoning_contracts.py`
- `python/tests/test_attached_citations.py`
- `python/tests/test_cutover_negative_gates.py`
- `apps/web/src/lib/search/searchApi.test.ts`
- `apps/web/src/lib/api/sse/events.test.ts`
- `apps/web/src/components/chat/useChatMessageUpdates.test.tsx`
- `apps/web/src/components/chat/useChatRunTail.test.tsx`
- `apps/web/src/components/chat/AssistantMessage.test.tsx`
