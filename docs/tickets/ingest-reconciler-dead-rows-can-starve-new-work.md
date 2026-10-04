# queued semantic work can monopolize bounded discovery

status: deferred; source-verified, runtime NOT_RUN.
origin: 2026-09-26 processing review; qualified 2026-10-03 at main `ba19f253`.
area: ingest reconciliation / transcript semantic admission.

historical source/index finding: the original review reported oldest-25 discovery
before queue ownership checks, followed by `suspended` for an exact dead source
job. current source/index discovery already excludes pending/failed/running/dead
jobs before its limit (`tasks/reconcile_stale_ingest_media.py:62-68,87-93`).
those reported paths are no longer the open problem.

semantic discovery still limits the oldest 25 readable pending/failed rows
without excluding their queue owners (`:98-110`).
`services/transcripts/semantic.py:73-85` returns `idempotent` for an existing
nonterminal same-media job without changing the transcript row. therefore 25
older queue-owned rows can prevent a newer jobless row from being discovered
while those jobs remain nonterminal. this is source evidence, not a live
starvation incident or provider/worker qualification.

prerequisite: adopt this deferred discovery-owner change separately. filter
nonterminal `podcast_reindex_semantic_job` ownership by the exact media payload
before order/limit. retain admission locks/rechecks/retries and the current
terminal/dead semantic repair policy; do not import source-job suspension policy.

acceptance: with 25 older eligible rows carrying real nonterminal jobs, discover
and enqueue one newer jobless obligation exactly once. another pass adds no
duplicate; existing jobs/state remain unchanged. terminal-job admission and
source/index discovery preserve their current contracts. no provider execution
is needed to qualify enqueue-only behavior.
