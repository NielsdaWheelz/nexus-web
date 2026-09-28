# model cutover is blocked by dead media generations

status: open; release blocker
origin: 2026-09-27 read-only production census, deployed `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`
area: migration 0246 / media enrichment

production is at database revision `0241`. `llm_calls` has 41
`media_enrichment` rows with `outcome IS NULL`. each has a dispatched
`llm_model_turns` row without a terminal. 41 `enrich_metadata` jobs are
`dead` and retain `generation_admissions`; no recorded tool positions were
found for the unsettled generations. the read-only census used aggregate
queries over `llm_calls`, `llm_model_turns`, `llm_tool_positions` and
`background_jobs`. migration `0246` rejects these retained-domain owners at
its domain preflight. dead jobs and missing tool rows do not establish a
provider terminal or absence of external effects.

before migration, the media owner must inventory exact job, generation,
turn, fingerprint, domain publication and effect identities; prove processes
and grants are closed; and settle or archive each uncertain old admission
without redispatch or fabricated outcomes. an audited, allowlisted disposition
must preserve media data, accepted effects and undo, and block stale replay
after the history reset. prove it on a copy of this production state with a
verified backup and the exact revised `0246` preflight. unknown owners stop
the release.
