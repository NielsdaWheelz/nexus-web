# chat_prompt_assemblies keeps three columns nothing reads

status: open · origin: 2026-09-21 chat-py reauthor (claude session), CHAT-03 · area:
chat prompt ledger

`chat_prompt_assemblies` has three columns with no reader anywhere in the
repository:

- `budget_breakdown` — the lane accumulator that produced it is gone; the
  reauthored `persist_prompt_assembly`
  (`python/nexus/services/context_assembler.py`) now writes `'{}'::jsonb`
  because the column is NOT NULL with a `jsonb_typeof = 'object'` CHECK
  (`migrations/alembic/versions/0236_baseline_schema.sql:512,517`).
- `included_retrieval_ids` — always `()` since the prompt-tracking module was
  proven a no-op; now written as `'[]'::jsonb` for the same NOT NULL reason.
  Its wire twin `TrustPromptAssemblyOut.included_retrieval_ids` stays on the
  trust trail and serves `[]`.
- `prompt_block_manifest` — the chat-py behaviour spec says
  `chat_context_refs.py:54` scans it, but no such file exists in this tree and
  `rg prompt_block_manifest` matches only the model, the baseline SQL and the
  writer. It is still written (per that spec) and is the only record of which
  prompt blocks a billed generation actually carried.

impact: three jsonb columns written on every send and read by nobody; one of
them (`prompt_block_manifest`) is nontrivially sized.

what has to be true first: confirm no operator query or export reads
`prompt_block_manifest`. `budget_breakdown` and `included_retrieval_ids` need
no further confirmation — this repository holds no reader.

proposed fix: one migration dropping `budget_breakdown` and
`included_retrieval_ids` (with their CHECKs), and the two literals in
`persist_prompt_assembly` with them; decide `prompt_block_manifest`
separately.

resolved when: the columns are gone from the schema and from the insert, or
`prompt_block_manifest` has a named reader recorded here.
