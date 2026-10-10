# background-lane job logs are discarded

status: open · origin: 2026-10-10 podcasts python reauthor (podpy harness D5b) · area: jobs / observability

The background lane runs each job in a child process whose stdout is
`subprocess.DEVNULL` (`python/nexus/jobs/process_executor.py:240`), and the
structured logger writes to stdout (`python/nexus/logging.py:102`). Every log
line a background job emits is lost; only stderr (tracebacks) reaches the
container log. Evidence: in the podpy harness a backfill step that skipped an
ambiguous item read `SourceLimited` with 7 items processed for 6 episodes, yet
no `podcast_episode_skipped` line appeared in any worker's log, while the same
line from a sync (interactive lane, in process) did.

impact: backfill skips (the design's mitigation for hidden identity problems),
and every other structured line from background jobs (ingest, indexing,
reconciliation), are invisible in production logs.

fix: let the child inherit the supervisor's stdout, or route the child's
structured logging to stderr.

acceptance: a backfill step that skips an item leaves one
`podcast_episode_skipped` line in the background worker's container log.
