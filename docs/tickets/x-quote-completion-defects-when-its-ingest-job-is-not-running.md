# X-post quote completion defects when its ingest job is not running

**Status:** open (pre-existing; surfaced while fixing the completion's lock cycle)
**Origin:** Imports workspace cutover, Track B re-review fix, 2026-09-08
**Area:** `python/nexus/services/media_source_ingest.py` (`complete_x_post_snapshot_attempt`),
`python/nexus/services/x_ingest.py` (`publish_x_thread_artifacts`)

## What is wrong

`complete_x_post_snapshot_attempt` accepts an in-flight quote attempt only when its
exact ingest job is `running`, or is `pending`/`failed` and unclaimed *while the
attempt itself is still `queued`* (`media_source_ingest.py:479-492`). Two ordinary,
reachable states fall outside that and raise `AssertionError` instead:

1. **A `running` attempt whose exact job is `failed` (or `pending`) — ordinary retry
   backoff.** `run_source_attempt`'s `mark_running` sets the attempt to `running`
   (`media_source_ingest.py:1313`); every non-terminal source failure is re-raised
   (`media_source_ingest.py:1613-1616`) and the worker's `fail_job` puts the job back
   to `failed` with a backoff. Nothing resets a live attempt from `running` to
   `queued` (the only `_ATTEMPT_QUEUED` writes are at lines 1062, 2822, 2912 and 2965,
   all on accepted/requeued attempts), so attempt=`running` + job=`failed` is the
   normal state between a failed execution and its retry claim. The `elif job.status
   != "running"` branch raises `AssertionError("in-flight X-post attempt has invalid
   job state")`. This is the dominant case in production.
2. **A nonterminal attempt whose exact job is `dead`.** That is precisely the state
   `source_repairable_sql` offers `RepairSource` for. The read is
   `find_nonterminal_jobs_for_payload`, which excludes `dead`, so the completion
   raises `AssertionError("in-flight X-post attempt has no exact ingest job")`
   (before this round the same state raised "invalid job state").

A quote reaches either state independently of its parent thread: embedded children
are enqueued and run on their own (`document_embeds.py:151-181`,
`media_source_ingest.py:3428-3435`), and `accept_embedded_source` returns the
existing in-flight attempt, which `x_ingest.py:390-397` then completes. In both
states the consequence is the same: the parent thread's handler dies on the
assertion and retries to dead, so the parent X thread can never be re-ingested until
the quote's attempt settles.

## Prerequisites

None.

## Proposed fix

Read the attempt's exact ingest job unlocked whatever its queue status (the
completion runs under the quote media's `FOR UPDATE`, so it must never wait on a
queue row a worker holds), and treat every status of that job as completable: the
parent's snapshot is the authority for the quote, and a succeeded attempt already
removes the media from the repair offer (`source_repairable_sql` requires a
nonterminal attempt), so a `dead` or `failed` row can stay as it is. Keep superseding
only the unclaimed `pending`/`failed` row (already non-blocking through
`supersede_unclaimed_job`), and keep the defect assertion only for a job identity
that does not belong to the attempt.

## Acceptance

`test_import_source_recovery.py` carries a named case per reachable state — a quote
whose ingest job dead-letters, and a quote whose execution failed into retry backoff
— each completed from a parent thread publication, each leaving `Complete`
capabilities and offering no repair; the file stays green; and no assertion path
remains for a quote attempt whose exact job is not `running`.
