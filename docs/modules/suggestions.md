# suggestions

`services/suggestions.py` owns the exact relevance policy and bounded current
eligibility. `services/suggestion_shortlists.py` owns admission, publication,
reads and the queue handler. quick reads retain their direct query. the full
product contract is the publication plan in #633.

## durable facts

- `suggestion_inputs` is the migration-seeded singleton revision. source owners
  call `suggestion_changes.record_input_change` after their last domain operation,
  immediately before commit. it flushes, increments and notifies; no domain lock
  may be acquired afterward. broad invalidation deliberately fits one user.
- `suggestion_feeds` registers a viewer/destination and points to its one
  unfinished job. a null library means lectern. dead work retains its pointer.
- `suggestion_shortlists` holds only the latest successful ordered pool of at
  most 80 canonical refs. empty is a successful publication. metadata is hydrated
  from current facts; stored relevance age never grants access.

`suggestion_shortlist_refresh` runs on the existing serial background lane with
its normal three-attempt policy and `keep_dead=True`. its payload is `{feed_id}`.
admission is serializable and joins existing work. a read-only repeatable-read
snapshot captures the input revision, database time and ranking. a short
serializable publication transaction locks the execution claim, verifies the
feed pointer and destination authority, replaces the publication, clears the
pointer and finishes the job atomically. a newer input revision remains visibly
dirty. workers never enqueue successors.

source changes record dirtiness even with no registered feed. only an active
observer requests work, for meaningful changes or the 15-minute age target.
later builds become available no earlier than the previous snapshot time plus
30 seconds. no queue completion deadline is promised.

## ports

both `/lectern/suggestions` and `/libraries/{library_id}/suggestions` expose:

- `GET`: latest publication, state and current eligible hydrated candidates.
- `POST /view`: reconcile up to 80 distinct supplied refs in their original
  order, independently of the latest publication. no ranking or admission.
- `POST /refresh`: `EnsureFresh` or conditional `Explicit` admission; return
  202 after commit. repeating an explicit request for an old publication cannot
  start new work after its replacement appears.

`/stream/lectern/suggestions` and
`/stream/libraries/{library_id}/suggestions` expose `Current {state}` or terminal
`Withdrawn`. each reread reauthorizes. the global `nexus_suggestions` / `changed`
notification is a wakeup hint; durable revisions are truth. the comparison
payload excludes the moving observation clock. queue history hooks notify for
retry, reclaim and dead transitions; first claim is observed at the next existing
15-second stream reconciliation.

library teardown explicitly deletes shortlist then feed. orphaned jobs finish
superseded. non-admin/system libraries expose no publication. a full lectern
keeps browsable suggestions; its capability separately disables new additions.

## operator repair

diagnose and fix the recorded queue failure first. age, source changes and
navigation cannot bypass dead work. identify the feed's `current_job_id`, inspect
that row and its `execution_id`, `error_code`, `last_error` and result, then use
the existing same-job repair in the intended environment. this grants one fresh
budget; it does not replace the job or discard the last publication.

```python
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.jobs.queue import get_job, requeue_dead_job
from nexus.services.suggestion_changes import notify_suggestions

job_id = UUID("the-diagnosed-job-uuid")
with get_session_factory()() as db:
    job = get_job(db, job_id, lock=True)
    assert job is not None and job.kind == "suggestion_shortlist_refresh"
    assert db.scalar(text(
        "SELECT EXISTS (SELECT 1 FROM suggestion_feeds WHERE current_job_id = :id)"
    ), {"id": job_id})
    if requeue_dead_job(db, job_id=job_id):
        notify_suggestions(db)
    db.commit()
```

the queue update and observer notification commit together. a job already
repaired is unchanged. confirm the same job publishes successfully and its feed
pointer becomes null; do not delete a dead row to obtain another attempt budget.
