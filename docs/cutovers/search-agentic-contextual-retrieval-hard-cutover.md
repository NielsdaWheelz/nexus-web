# Search Agentic Contextual Retrieval Hard Cutover

**Status:** Planner/read-handoff, chat tool-loop hardening, long-context
eligibility ledger, and contextual source-map read model implemented - 2026-06-20

**Type:** Hard cutover. Add the future-facing retrieval layer only after evals,
packer correctness, candidate policy, and deterministic selection are in place.

## One-Line

Add deep-retrieval behavior for hard questions: query planning, iterative
search/inspect/read loops, contextual chunks, hierarchy-aware retrieval,
graph-assisted expansion, and long-context routing.

## Implemented Slices

- `search/policy.py` owns a deterministic `plan_app_search` decision with
  query class, candidate limit, retrieval mode, and policy reason.
- `app_search` persists that plan in the existing rerank ledger metadata instead
  of recording successful searches as `unclassified`.
- The compact `app_search` tool output exposes `selected_count`,
  `more_candidates_available`, and `read_uri` for selected results that
  `read_resource` can actually read.
- `read_resource` admits a URI selected by `app_search` in the same assistant
  message, using existing chat telemetry as the handoff ledger.
- Chat enforces a run-level aggregate tool-output budget before adding tool
  results to provider continuation turns.
- Chat finalizes max-tool-iteration exhaustion as a typed terminal error instead
  of silently falling through to a complete run.
- `app_search` ledgers a private `context_route` policy: default
  `search_fetch_read`, with `long_context_candidate` only for an explicit
  single-media whole-source query. This is eligibility metadata, not execution.
- `content_indexing` exposes deterministic `source_map.v1` read models for
  content chunks from the existing `content_chunks`, `content_chunk_parts`,
  `content_blocks`, and `evidence_spans` rows.
- Selected `content_chunk` results carry compact source-map guidance in
  `app_search` output and aggregate source-map visibility in rerank metadata.
  Source maps do not become citation targets.

Deferred by design: graph expansion, generated contextual summaries,
hierarchical artifacts, and long-context execution.

## Why This Is Last

Agentic and graph/hierarchical retrieval can be powerful, but they are expensive
and easy to overfit. They should not compensate for a shallow candidate pool or a
broken packer. This cutover assumes the earlier four cutovers are complete.

## Research Inputs

- OpenAI Deep Research frames deep retrieval as multi-step source discovery,
  analysis, synthesis, and citation over web, files, MCP, and code tools:
  `https://openai.com/index/introducing-deep-research/`
  and
  `https://developers.openai.com/api/docs/guides/deep-research`
- OpenAI's Deep Research MCP interface requires a search tool and a fetch tool,
  matching Nexus's split between `app_search` and `read_resource`:
  `https://developers.openai.com/api/docs/guides/deep-research`
- Reasoning Agentic RAG surveys describe the field's move from static pipelines
  toward dynamic retrieval, planning, self-reflection, and tool use:
  `https://arxiv.org/html/2506.10408v1`
- Long-context research suggests a hybrid route: use RAG for cost and focus, but
  route some questions to long-context modes when needed:
  `https://arxiv.org/html/2407.16833v1`
- Gemini long-context docs show that million-token contexts unlock direct-context
  workflows, while RAG/filtering remain useful strategies:
  `https://ai.google.dev/gemini-api/docs/long-context`
- Microsoft LazyGraphRAG argues for blending vector RAG and graph RAG while
  deferring expensive LLM graph work until query time:
  `https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/`
- Recent graph/hierarchical RAG work emphasizes local/global query modes,
  hierarchical summaries, entity graphs, and stage-specific evaluation:
  `https://arxiv.org/html/2505.24226v2`
  `https://arxiv.org/html/2506.05690v2`
  `https://arxiv.org/html/2503.10150v2`
  `https://arxiv.org/html/2502.09891v3`
- NotebookLM's evolution is a product signal: source-grounded chat is moving
  toward source discovery, agentic actions, generated artifacts, and visible
  steps, but user reports still show demand for source control and transparency:
  `https://support.google.com/notebooklm/answer/16179559?hl=en`
  `https://www.theverge.com/news/642490/google-notebooklm-discover-sources-ai-audio-overviews`

## Scope

Add a deep retrieval mode that can choose among:

- search only
- search then inspect
- search then read exact passages
- query decomposition into several searches
- scoped source discovery
- graph/context expansion from existing `ResourceRef` relationships
- long-context route for small enough source sets
- contextual/hierarchical source maps for broad/global questions

This must remain grounded in existing owners:

- Search owns candidate generation and retrieval policy.
- Chat owns tool orchestration and prompt budgeting.
- Resource graph owns context/citation edges.
- Content indexing or a new generated-artifact owner owns contextual and
  hierarchical index artifacts.

## Query Planner

The planner should classify:

- answerable from current attached context
- needs local search
- needs exact read
- needs inspect/map before read
- needs cross-source synthesis
- needs absence/breadth search
- needs long-context route
- needs web search or outside-source discovery

The first planner can be deterministic. A model-based planner should be added
only when its decisions can be evaluated against tool-call accuracy fixtures.

## Tool Loop Contract

Harden the tool loop as part of deep retrieval:

- aggregate tool-output prompt budget, not only per-tool caps
- typed state for max-tool-iteration exhaustion
- "more candidates available" signal in tool output/trust trail
- clear system-prompt guidance for search vs inspect vs read
- no hidden uncited evidence path
- no web/private-source mixing without an explicit policy boundary

OpenAI Deep Research's search/fetch split is the right conceptual shape:
`app_search` discovers candidates; `read_resource` fetches exact evidence.

## Contextual Indexing

Add contextual chunk headers or summaries only after the deterministic retrieval
path is measured.

First slice implemented: deterministic `source_map.v1` derives from the current
content index and attaches section/context guidance to selected `content_chunk`
results. It is source-derived retrieval guidance, not generated evidence.

Candidate artifacts:

- chunk context header
- section title/path
- parent document summary
- generated source map
- entity/concept tags
- section-level summary node
- document-level summary node

Requirements:

- reindex is deterministic and versioned
- generated artifacts identify their owner and source revision
- citation targets remain concrete resources
- summary nodes can guide retrieval but must not become unsupported citations

## Graph And Hierarchy

Graph/hierarchical retrieval is useful for:

- global questions
- multi-hop relationships
- "what themes recur across my library?"
- "where do sources disagree?"
- "what should I read next?"

It is less likely to help exact lookup or single passage questions.

Use graph structure as a retrieval guide, not as a substitute for concrete
evidence. Existing `resource_edges` can support expansion, but `app_search` must
not query graph rows directly. The graph/context owner should expose typed read
models for search to consume.

## One-Year / Five-Year / Ten-Year View

One year:

- hybrid sparse+dense retrieval with contextual chunks is table stakes
- reranking and eval dashboards become default
- source-grounded agents use search/fetch/read loops
- long-context routing is used selectively for small corpora or high-stakes deep
  reads

Five years:

- personal retrieval systems maintain continuously updated source maps,
  concept graphs, and user-specific ranking signals
- models plan retrieval as part of reasoning, not as an external pre-step
- citations carry richer provenance, confidence, and contradiction metadata
- local/private retrieval and external web research are policy-routed

Ten years:

- retrieval becomes a persistent memory substrate, not a search feature
- systems maintain living, versioned models of a user's library and projects
- question answering, reading, note-taking, and research become one evidence
  operating system
- context windows are huge, but retrieval still matters for cost, privacy,
  focus, provenance, and controllable evidence

These are forecasts, not current guarantees. The implementation path should keep
Nexus adaptable by making retrieval decisions typed, measured, and inspectable.

## Acceptance Criteria

- Deep mode is opt-in or policy-routed, not the default for every query.
- Query planner decisions are ledgered.
- Search/fetch/read tool use can be evaluated.
- Max tool iterations and aggregate tool budget are typed and tested.
- Contextual/hierarchical artifacts are versioned and owner-bound.
- Graph expansion never bypasses `ResourceRef` or capability policy.
- Citation targets remain concrete, user-activatable resources.

## Likely Files

- `python/nexus/services/chat_prompt.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/context_assembler.py`
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/agent_tools/read_resource.py`
- `python/nexus/services/agent_tools/inspect_resource.py`
- `python/nexus/services/content_indexing.py`
- `python/nexus/services/search/*`
- `python/tests/test_chat_runs.py`
- `python/tests/test_agent_app_search.py`
- new agentic retrieval eval tests

## Tests To Add

- Planner chooses search/read/inspect for representative query classes.
- Multi-hop tool sequence stops with a typed state when the cap is reached.
- Tool-output aggregate budget is enforced.
- Search result followed by read_resource produces citable exact evidence.
- Long-context route is selected only under explicit policy.
- Generated contextual artifacts reindex deterministically.
- Graph expansion respects capability policy and source visibility.

## Verification

Run focused tests:

- retrieval eval harness
- `python/tests/test_chat_runs.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_attached_citations.py`
- `python/tests/test_cutover_negative_gates.py`
- relevant frontend SSE/trust-trail parser tests
