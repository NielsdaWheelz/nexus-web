# terminal generations retain running tool receipts

bounded read-only production inspection on 2026-10-29 utc, schema 0317, found
144 `tool_calls` with `status='running'`. every row joins through
`tool_calls.generation_id = llm_calls.id` to a distinct `media_enrichment`
generation whose `outcome='Failed'`; the tool rows date from 2026-10-14
12:36:40–12:59:49 utc. no open `llm_calls` were present. all 21 chat runs were
complete, and no pending/running/failed background jobs were present at that
observation. this is historical receipt inconsistency, not proof of active work.

impact: stored tool history can imply execution after its generation is terminal;
a drain census that counts raw tool status would incorrectly report active work.
inspect the historical settlement path and current
`python/nexus/services/generation/ledger.py:113-123` before choosing a repair.
do not manufacture tool outcomes or rewrite history during release admission.

private corrected-join evidence: `nexus-x-census-opev6bzp`,
`drain-classification-corrected.stdout`, sha256
`8d11ca9d3dd841aca0f5690758977c00a16b1fe4f8257da37acceda5de6ffc21`.
the earlier owner-id join in that directory was incorrect and is not evidence.
no production data changed.

resolved when current terminal settlement cannot retain an executing receipt,
the historical rows have an explicit truthful disposition, and release admission
distinguishes terminal history from genuinely admitted generation work.
