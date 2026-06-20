# Search Retrieval Evals Hard Cutover

**Status:** Implemented - 2026-06-20

**Type:** Hard cutover. No retrieval-quality work ships without a measured
baseline, stage-specific metrics, and a reproducible replay path.

## One-Line

Create the golden retrieval evaluation substrate that makes search changes
falsifiable: query fixtures, relevant refs, candidate-pool metrics, selected-pack
metrics, citation/grounding checks, and regression reporting for chat
`app_search`.

## Why This Is First

The original `app_search` bottleneck was visible: it retrieved eight candidates,
selected at most six, and capped rendered context at 16k chars. The unsafe move
was to raise those values before proving where evidence was lost.

The professional move is to answer these questions first:

- Did indexing contain the relevant evidence?
- Did shared search retrieve it in a wider candidate pool?
- Did reranking place it high enough?
- Did the packer include or drop it?
- Did the model cite it accurately?
- Did the trust trail explain the decision?

Each layer needs separate measurement. Otherwise "better retrieval" becomes a
subjective chat transcript review.

## Research Inputs

- Ragas documents retrieval, response, grounding, and agent/tool metrics:
  `https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/`
- LlamaIndex's retriever evaluator uses hit-rate, MRR, precision, recall, AP,
  and NDCG:
  `https://developers.llamaindex.ai/python/examples/evaluation/retrieval/retriever_eval/`
- Ragas context precision evaluates whether relevant chunks are ranked ahead of
  irrelevant chunks:
  `https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/`
- GraphRAG-Bench argues for stage-specific metrics across graph construction,
  retrieval, and final generation:
  `https://arxiv.org/html/2506.05690v2`
- Long-context RAG research shows that adding more retrieved passages can
  eventually hurt because of hard negatives:
  `https://openreview.net/forum?id=oU3tpaR8fm`

## Scope

Add an offline retrieval-eval harness for Nexus-owned resources. It should not
call a provider by default; it should replay search, candidate projection,
selection, and ledger behavior deterministically.

The harness must support:

- Golden query fixtures with expected relevant `ResourceRef` targets.
- Optional graded relevance for queries with many partially relevant answers.
- Query class labels:
  - exact lookup
  - scoped passage lookup
  - cross-document synthesis
  - global library question
  - multi-hop search/read/inspect question
  - negative/absence question
  - recency or conversation question
- Candidate-pool evaluation at multiple depths.
- Selected-evidence evaluation after `app_search` packing.
- Failure classification by stage.
- A compact text/JSON report suitable for local tests and future CI artifacts.

## Metrics

Candidate-pool metrics:

- Recall@K
- MRR
- Precision@K
- NDCG or AP where graded relevance exists
- exact-match ref hit rate
- stage latency
- candidates by result type, source, and scope

Evidence-pack metrics:

- selected evidence recall
- selected token/char count
- skipped/trimmed/duplicate/uncitable counts
- source diversity
- section diversity
- "first relevant selected" rank
- "relevant retrieved but not selected" count

Answer-layer metrics, when provider-backed tests are deliberately enabled:

- faithfulness or groundedness
- answer relevance
- citation precision
- unsupported-claim count
- tool-call accuracy for agentic retrieval flows

## Fixture Shape

Use a small explicit fixture format rather than burying relevance in test code.

Example shape:

```yaml
id: exact_quote_media_title
query: "where does the text mention the blue notebook?"
class: scoped_passage_lookup
scope_refs:
  - media:00000000-0000-0000-0000-000000000001
relevant_refs:
  - ref: content_chunk:00000000-0000-0000-0000-000000000002
    grade: 3
  - ref: evidence_span:00000000-0000-0000-0000-000000000003
    grade: 3
expectations:
  recall_at_20: true
  selected_pack_contains_any: true
```

The exact storage format can be JSON if that better matches existing test
helpers. The important contract is that relevance lives beside the query and can
be reused across candidate, packer, and answer-level checks.

## Implementation Notes

- Start with synthetic DB fixtures in existing backend tests, then add a small
  manually curated real-library regression set when available.
- Preserve the legacy depth-8 comparison as the eval baseline.
- Evaluate candidate depths 8, 20, and 50. Runtime now uses the search-owned
  20/50 candidate policy, while selected evidence remains capped separately.
- Keep eval helpers under test ownership until there is a reason to expose them
  as operator tooling.
- Provider-backed answer evaluation should be opt-in and skipped by default.

## Acceptance Criteria

- The baseline report shows current candidate recall and selected-pack recall.
- Candidate-generation failure and evidence-packing failure are distinguishable.
- At least one fixture exists for each query class listed above.
- The harness can compare candidate limits without changing production behavior.
- Tests fail clearly when a relevant ref is indexed but lost before selection.
- No LLM/provider call is required for the default test lane.

## Likely Files

- `python/tests/test_search.py`
- `python/tests/test_agent_app_search.py`
- new `python/tests/test_search_retrieval_evals.py`
- optional `python/tests/fixtures/search_retrieval_evals.*`
- optional test helper under `python/tests/support/`

## Verification

Run the smallest meaningful backend tests:

- `python/tests/test_search_retrieval_evals.py`
- focused `python/tests/test_agent_app_search.py`
- focused `python/tests/test_search.py`

Do not run provider-backed answer evals in ordinary unit/integration gates.
