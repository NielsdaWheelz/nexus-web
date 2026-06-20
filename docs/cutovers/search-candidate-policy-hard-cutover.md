# Search Candidate Policy Hard Cutover

**Status:** Implemented - 2026-06-20

**Type:** Hard cutover. Separate candidate-generation depth from selected
evidence depth without adding private `app_search` search semantics.

## One-Line

Replace `app_search`'s single local `APP_SEARCH_LIMIT = 8` candidate cap with an
owned retrieval policy that can over-retrieve from shared search, evaluate
candidate depths, and still return a bounded selected evidence pack.

## Problem

The shared search layer already has a wider hybrid substrate:

- shared `SearchQuery`
- hybrid vector ANN plus lexical FTS
- `CANDIDATES_PER_TYPE = 200`
- public `MAX_LIMIT = 50`
- multi-scope union/dedupe in `search_scopes`

But `app_search` builds `SearchQuery(limit=8)`, which caps the visible candidate
pool before chat-specific selection can do useful work. This conflates two
different policies:

- candidate depth: how much evidence is inspected
- selected evidence depth: how much evidence is shown to the model

The first belongs to search/retrieval policy. The second belongs to chat evidence
packing.

## Research Inputs

- Anthropic's contextual retrieval writeup and cookbook describe a modern
  pattern: contextual chunks, hybrid sparse+dense retrieval, retrieve many
  candidates, rerank, then pass a smaller set to the model:
  `https://www.anthropic.com/engineering/contextual-retrieval`
  and
  `https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide`
- Azure AI Search recommends feeding semantic ranking with a sufficiently large
  candidate pool, commonly 50 inputs, while separately controlling returned
  results:
  `https://learn.microsoft.com/en-us/azure/search/hybrid-search-how-to-query`
- OpenAI File Search exposes result-limit customization while warning that lower
  limits trade quality for token/latency savings:
  `https://developers.openai.com/api/docs/guides/tools-file-search`

## Scope

Introduce a retrieval policy layer for chat `app_search` candidate generation.

The target policy should choose candidate depth based on query class and mode:

- exact lookup: smaller candidate pool, high exact-match priority
- scoped passage lookup: moderate candidate pool within scope
- cross-document/global: wider candidate pool
- absence question: wider candidate pool plus explicit "searched scope" metadata
- multi-hop: moderate first pass, then iterative follow-up via tools

Initial candidate-depth experiments should compare:

- current 8
- 20
- 50

Do not exceed the public `MAX_LIMIT = 50` in the first production slice unless a
search-owned internal candidate API is explicitly designed.

## Open Design Decision

The public search response max and internal candidate-inspection max may need to
be different.

Conservative first move:

- Use `SearchQuery(limit=50)` for deep `app_search` candidate inspection.
- Keep selected evidence bounded.
- Keep public `/search` pagination unchanged.

Future search-owned move:

- Add an internal candidate API that returns candidate metadata before public
  projection and pagination.
- Keep this under `python/nexus/services/search/`, not `app_search`.

## Policy Metadata

Persist policy data in rerank/tool metadata:

- query class
- candidate limit
- selected evidence limit
- context budget
- scope count
- result type mix
- fast/deep mode
- reason for policy choice

The trust trail should make it obvious whether a shallow answer came from a fast
policy, a narrow user scope, no indexed evidence, or a true absence result.

## Implementation Notes

The first production slice keeps policy deliberately narrow and scope-driven:

- single `media:` scope -> moderate candidate pool (`20`)
- library, conversation, multi-scope, and global searches -> deep candidate pool
  (`50`)
- selected evidence remains capped at `6`
- query-class metadata is persisted as `unclassified`
- multi-scope persistence uses a bounded `multi_scope:<count>` label plus the
  full resolved scope list in rerank metadata
- result-type mix metadata is actual candidate output, not the requested kinds

This cutover does not add a query planner, private `app_search` filters, learned
reranking, or an internal search API. The eval harness carries query-class
fixtures and candidate-depth deltas, and writes its JSON report under pytest's
`tmp_path`; the next rerank-selection cutover owns better ordering and diversity
inside the selected evidence pack.

## Acceptance Criteria

- `APP_SEARCH_LIMIT = 8` is no longer the only candidate-generation policy.
- Candidate pool depth is distinct from selected evidence depth.
- Runtime still uses shared `SearchQuery` and `search_scopes`.
- No `app_search`-private `media_id`, `library_id`, `semantic`, or result-type
  lanes are introduced.
- Eval reports show recall deltas for candidate depths 8, 20, and 50.
- Tool output remains bounded and deterministic.

## Likely Files

- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/search/query.py`
- `python/nexus/services/search/service.py`
- `python/nexus/services/search/batch.py`
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_batch.py`
- `python/tests/test_search_retrieval_evals.py`

## Tests To Add

- Candidate limit can be varied without changing selected evidence limit.
- Wider candidate pool improves recall on at least one eval fixture.
- Public `/search` default/max behavior does not change.
- Multi-scope candidate policy still dedupes by `(type, id)`.
- Policy metadata persists in rerank/tool ledgers.
- Deleted/private tool args remain rejected.

## Verification

Run focused backend tests:

- retrieval eval harness
- `python/tests/test_agent_app_search.py`
- `python/tests/test_search_batch.py`
- `python/tests/test_search.py`
- `python/tests/test_search_intent_model_guards.py`
