# Search Rerank And Selection Hard Cutover

**Status:** Proposed - 2026-06-20

**Type:** Hard cutover. Add deterministic second-stage selection before any
learned or provider-backed reranker.

## One-Line

Turn selected evidence from "prompt-evidence first, then greedy budget" into an
explicit rerank and diversity selector that balances relevance, exactness,
source/section diversity, citation quality, and prompt budget.

## Problem

After candidate generation improves, a naive selected pack can still fail:

- one document can crowd out other relevant sources
- high semantic similarity can beat exact lexical evidence
- container rows can outrank concrete passages
- long chunks can consume the whole budget
- broad questions need coverage, while exact questions need concentration

This cutover makes second-stage selection a real owner-layer concept.

## Research Inputs

- Anthropic's retrieval experiments stack contextual embeddings, BM25, and
  reranking; reranking provides the highest accuracy but adds latency/cost:
  `https://www.anthropic.com/engineering/contextual-retrieval`
- The Claude cookbook reports concrete tradeoffs between contextual embeddings,
  hybrid search, and reranking:
  `https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide`
- Long-context RAG research warns that adding more retrieved passages can reduce
  output quality when hard negatives enter the context:
  `https://openreview.net/forum?id=oU3tpaR8fm`
- Ragas context precision frames ranking quality as placing relevant chunks
  before irrelevant chunks:
  `https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/`

## Scope

Implement a deterministic selector over a widened candidate pool.

Initial features:

- hybrid normalized score
- lexical exactness and phrase match
- result type
- citation target quality
- source/document id
- section/page/locator proximity
- scope match
- recency where relevant
- renderable evidence length
- duplicate source/section penalties

Initial selection policies:

- exact lookup: prioritize exact lexical/title/person matches; low diversity
  pressure
- scoped passage lookup: prioritize concrete passages within the scope
- cross-document/global: apply MMR or equivalent source diversity
- absence question: prioritize broad coverage and ledger searched scopes
- multi-hop: select enough evidence to decide next tool call, not final answer

Do not add a learned cross-encoder or LLM reranker in this cutover. The first
selector must be deterministic, locally testable, and easy to inspect.

## Rerank Ledger Contract

The rerank ledger must record:

- strategy name and version
- query class
- input candidate count
- selected count
- candidate limit
- selected evidence budget
- selected chars/tokens
- per-candidate score features where feasible
- per-candidate selected/skipped reason
- diversity constraints applied

If the existing tables cannot cleanly hold this, prefer a small metadata schema
extension over inventing a parallel telemetry store.

## Acceptance Criteria

- Selected evidence is deterministic for fixed candidate inputs.
- Broad/global fixtures select diverse sources when relevant evidence exists.
- Exact lookup fixtures do not regress through over-diversification.
- Passage evidence remains preferred over container rows where both are relevant.
- Hard-negative noise is measurable in eval reports.
- Rerank ledgers explain why candidates moved up, moved down, or were skipped.

## Future Learned Reranker Gate

A provider-backed, cross-encoder, or LLM reranker can be considered only after:

- deterministic selector metrics are stable
- eval fixtures include enough real failures to justify cost
- latency and token budgets are explicit
- provider failure has a typed fallback
- reranker output is ledgered and auditable

Potential future providers/approaches:

- local cross-encoder reranker
- hosted reranker
- LLM pairwise/listwise rerank over top candidates
- per-user learned ranking from accepted citations and read behavior

## Likely Files

- new `python/nexus/services/search/selection.py` or similar
- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/search/ranking.py`
- `python/nexus/db/models.py` only if ledger schema needs extension
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_retrieval_evals.py`

## Tests To Add

- Deterministic selector output for fixed candidates.
- Exact lookup preserves top exact evidence.
- Broad query selects multiple sources.
- Duplicate section/source penalty works.
- Container row loses to concrete passage when both represent same source.
- Rerank ledger metadata has strategy/version/reasons.

## Verification

Run focused tests:

- retrieval eval harness
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search.py`
- `python/tests/test_chat_runs.py`
- relevant trust-trail tests
