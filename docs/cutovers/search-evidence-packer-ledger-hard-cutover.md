# Search Evidence Packer And Ledger Hard Cutover

**Status:** Proposed - 2026-06-20

**Type:** Hard cutover. Replace greedy/ambiguous `app_search` packing with
deterministic, explainable evidence-selection behavior.

## One-Line

Fix the current `app_search` evidence packer before increasing retrieval depth:
skip or trim oversized blocks, continue to later candidates, ledger every
decision, and make tool-output prompt inclusion explicit.

## Problem

`render_retrieved_context_blocks` currently loops through sorted citations,
renders each block, and stops when the next block would exceed
`APP_SEARCH_CONTEXT_CHARS`. That means an early oversized block can prevent later
useful candidates from being selected.

The current ledger state is also too coarse:

- selected candidates are reasoned as `within_context_budget`
- unselected candidates are often reasoned as `below_selected_limit`
- `message_rerank_ledgers.strategy` says
  `prompt_evidence_then_context_budget`
- selected `app_search` rows can remain `included_in_prompt = false` even though
  their selected snippets are returned to the model as tool output

This is a correctness and trust-trail problem independent of candidate recall.

## Research Inputs

- Long-context RAG work shows that more context can hurt when hard negatives are
  included, so packers must actively select and order evidence instead of only
  appending more:
  `https://openreview.net/forum?id=oU3tpaR8fm`
- NotebookLM help states that with many sources the system retrieves relevant
  information first and builds a response from it; user reports show frustration
  when source/context limits are opaque:
  `https://support.google.com/notebooklm/answer/16269187?hl=en`
  and
  `https://www.reddit.com/r/notebooklm/comments/1l2aosy/i_now_understand_notebook_llms_limitations_and/`
- Ragas separates retrieval context quality from final answer quality, which is
  the same separation needed for Nexus packer telemetry:
  `https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/`

## Scope

Change evidence packing only. Do not widen candidate generation in this cutover.

Required behavior:

- Empty rendered blocks are skipped and ledgered.
- Oversized blocks do not stop the loop.
- Oversized blocks are either:
  - skipped with an explicit reason, or
  - trimmed to a bounded excerpt with an explicit reason.
- Later candidates can still be selected after an oversized candidate.
- Selected evidence rows expose prompt-inclusion semantics appropriate to
  tool-output evidence.
- Rerank/candidate ledgers explain selected and unselected candidates.
- Citation edge behavior stays unchanged.

## Selection Reasons

Use explicit reason strings. Initial vocabulary:

- `selected_within_budget`
- `selected_trimmed_to_budget`
- `skipped_over_budget`
- `skipped_empty_render`
- `skipped_duplicate_source`
- `skipped_duplicate_section`
- `skipped_uncitable`
- `skipped_selected_limit`
- `retrieved_not_selected`

The exact final names can differ, but the categories must survive.

## Prompt Inclusion Semantics

The current prompt assembly ledger tracks initial prompt evidence, while
`app_search` selected results are returned later as tool output. This cutover must
make that distinction explicit.

Safe options:

- Add a separate telemetry state for tool-output inclusion.
- Or set `included_in_prompt = true` for selected tool-output evidence and add
  metadata showing it was included through a tool message, not initial assembly.

Do not silently leave selected model-visible evidence indistinguishable from
retrieved-but-not-shown evidence.

## Acceptance Criteria

- A first oversized candidate cannot block later useful selected candidates.
- All non-selected candidates have a stable, meaningful ledger reason.
- Existing selected retrieval rows still mint citation edges through chat-run
  citation ownership.
- `message_retrievals` remains telemetry and uses the single validated writer.
- Trust-trail consumers can explain why each candidate was selected or dropped.
- No search candidate limit changes are included in this cutover.

## Likely Files

- `python/nexus/services/agent_tools/app_search.py`
- `python/nexus/services/retrieval_citation.py` if writer metadata expands
- `python/nexus/db/models.py` only if existing columns cannot express the state
- `python/tests/test_agent_app_search.py`
- `python/tests/test_chat_runs.py`
- relevant trust-trail/frontend parser tests if output shape changes

## Tests To Add

- Oversized first block, later fitting block selected.
- Oversized block trimmed when trimming is enabled.
- Empty render does not count against selected limit.
- Selected evidence has tool-output inclusion semantics.
- Candidate ledger reason coverage.
- Citation ordinals remain dense and graph-owned.

## Verification

Run focused backend tests:

- `python/tests/test_agent_app_search.py`
- `python/tests/test_chat_runs.py`
- `python/tests/test_attached_citations.py`
- `python/tests/test_cutover_negative_gates.py`
