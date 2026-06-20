# Search Rerank And Selection Hard Cutover

**Status:** First deterministic selector slice implemented - 2026-06-20

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

Implemented selector features:

- hybrid normalized score
- lexical exactness and phrase match
- result type
- citation target quality
- source/document id
- locator-derived section/page/time bucket where present
- duplicate source/section penalties

At this slice boundary, runtime still recorded `query_class = "unclassified"`.
These query-class policies were left to the later retrieval-controller/planner
cutover, not hidden inside the selector:

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

## Implementation

First slice implemented:

- Added `python/nexus/services/search/selection.py` with deterministic
  app-search candidate reranking.
- `app_search` now reranks candidates before the existing context-budget packer.
- `app_search` can render selected persisted `web_result` rows instead of
  skipping them as empty evidence.
- `message_rerank_ledgers.strategy` now records
  `app_search_deterministic_selection`.
- Rerank metadata records strategy/version, ordering policy, diversity policy,
  budget policy, candidate limits, result-type mix, selection reason counts, and
  a per-candidate rerank trace with final selected/skipped pack outcomes.
- Existing `message_retrievals`, candidate ledgers, and rerank ledgers were
  sufficient; no schema extension or parallel telemetry store was needed.
- The selector remains deterministic and local. No learned, provider-backed, or
  LLM reranker was added.

## Tests Added Or Updated

- Deterministic selector output for fixed candidates.
- Exact lookup preserves top exact evidence.
- Broad query selects multiple sources.
- Duplicate section/source penalty works.
- Container row loses to concrete passage when both represent same source.
- Rerank ledger metadata has strategy/version/reasons.
- Retrieval eval reports now include selected false-positive noise.
- Public `web_search` writes the shared rerank ledger with provider-rank policy
  metadata and per-candidate pack outcomes.
- Trust-trail rendering shows the deterministic selector policy line.

## Verification

Run focused tests:

- retrieval eval harness
- `python/tests/test_search_selection.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_retrieval_evals.py`
- `python/tests/test_message_retrievals.py`
- `python/tests/test_web_search_route.py`
- `python/tests/test_openai_reasoning_contracts.py::test_app_search_policy_survives_chat_run_dispatch_and_trust_trail`
- `apps/web/src/components/chat/AssistantMessage.test.tsx`
