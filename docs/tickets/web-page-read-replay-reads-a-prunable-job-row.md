# web page read follows a dedupe rehome through a job row that pruning now deletes

status: open · origin: 2026-09-18 owner decisions (D149 verification) · area:
agent tools / jobs

`python/nexus/services/agent_tools/web_page_read.py` `_load_canonical_dedupe_winner`
is the only reader of `background_jobs.result` in the tree: when an accepted
Web Article media is unreadable because its source was rehomed onto a canonical
duplicate, it loads the succeeded `ingest_media_source` job by id and reads
`result.superseded_by_media_id`, raising `WebPageReadDefect` if the row is gone.
`prune_background_jobs_job` now runs hourly in the background lane (oi-149)
and deletes succeeded rows after seven days; `never_prune_dead` protects dead
rows only.

impact: a stored `PageAcceptResult` receipt replayed more than seven days
later (a resumed dossier build, a chat regeneration) against a rehomed media
raises a defect instead of following the winner. inside a live turn the job is
minutes old and unaffected. before oi-149 the prune job never ran, so this
was unreachable.

fix: record the winner where the supersession is already durable.
`_supersede_source_media` emits a `SourceSuperseded` history event; if its
payload carries the winner id, read it from there and drop the job-row read.
otherwise persist `superseded_by_media_id` on the attempt.

resolved when: no tool reads `background_jobs.result` after the job's own
execution, and the replay case above follows the winner.
