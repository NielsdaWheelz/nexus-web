# suggestions

suggestions propose what to put on the lectern or into a library; quick reads
are short unfinished documents. `services/suggestions.py` owns the exact
relevance policy and current eligibility. `services/suggestion_shortlists.py`
owns admission, publication, reads and the queue handler.
`services/suggestion_changes.py` owns the input revision, the engagement gate and
feed deletion. web: `lib/useSuggestions.ts` (the visit model),
`components/collections/SuggestionsSection.tsx`, `QuickReadsSection.tsx`.

## product contract

- destinations: the lectern (every viewer) and each library the viewer admins,
  All included. member-only and system libraries have none (`NotApplicable`).
- eligibility, one predicate for ranking and delivery: on the lectern, a visible
  unfinished media not on it; in a library, a visible media it does not hold,
  directly or through a filed show (a named library never offers an episode of a
  show it files), and for a named library a followed visible show it does not
  file. All proposes what the viewer can read but has not saved (grants, the
  oracle corpus).
- a feed exists only while its user administers its library: losing admin
  (demotion, removal, leaving) or deleting the library deletes the feed and its
  publication in the same transaction.
- one retained logical pane visit owns a hydrated pool (at most 80), including
  a successful empty publication. ten refs are displayed; survivors retain order,
  acknowledged additions leave, and vacancies refill only from that same pool.
  new publications do not replace it, fetch another pool, or announce freshness.
- current eligibility and metadata are reconciled independently through `/view`.
  ranking age never grants access or settles a pending command. a ref acknowledged
  after a read began is filtered from that read; adding locks only that command.
  a full lectern leaves suggestions browsable and disables additions.
- mobile switching, back/forward, minimize/restore and layout changes restore the
  existing account-scoped visit snapshot through `usePaneVisitData`. restore
  revalidates eligibility, never ranking. close/reopen follows its existing
  forgetting rules. no browser storage or extra retention owner.
- a new visit, reload or ordinary explicit refresh reads the latest completed
  snapshot. initial absence automatically accepts its first publication; empty
  is complete. an adopted empty or exhausted pool can stay empty until refresh.
- explicit refresh awaits its own bounded GET and installation, never queue work
  or another newer publication. a concurrent first automatic completion cannot
  regress to pending if this GET captured an older null snapshot. observed state
  can advance separately; the GET's coherent ranking remains adoptable.
- refresh outcomes: `Refreshed` (readable completed pool, empty included), `Finding`
  (no publication), `Repair` (no publication and suspended work), `Failed` (modeled
  read failure), `NotApplicable` (neutral library branch). lectern inapplicability
  is a defect. library refresh also syncs shows and retains that result, downgraded
  from complete to partial if the suggestions read fails or needs repair.
- the shell owns pane-refresh outcome speech. inline retry repeats only the
  failed suggestions intention and owns its own outcome. restored pools and
  background publications are silent. one initial collection loader, completed
  empty, actual read/admission failures, capacity and repair remain visible.
- cancellation retires request ownership; withdrawal clears retained selection.
  old `/view` reads are fenced to the exact adopted selection, even when explicit
  refresh reads the same publication id. later observer state never authorizes a
  retired response. only matching read success clears its failure intention;
  observation recovery cannot erase a failed explicit read.
- quick reads: at most five visible unfinished media with under ten minutes
  left, in progress first; a direct read, not published.

## durable facts

- `suggestion_inputs` is the migration-seeded singleton revision. source owners
  call `suggestion_changes.record_input_change` after their last domain operation,
  immediately before commit. it flushes, increments and notifies; no domain lock
  may be acquired afterward. broad invalidation deliberately fits one user.
- reading and listening advance it only when they move an anchor list or the
  read state. `engagement_gate`, taken before the write, reads the head of each
  anchor list the write can move (the lectern's, and each admin library's that
  holds the media or its show; a transcript save on an episode moves only the
  lectern's) and the read state; the write stamps the media's engagement now, so
  the anchors moved exactly when one of those lists was headed by something else.
- `suggestion_feeds` registers a viewer/destination and points to its one
  unfinished job. a null library means lectern. dead work retains its pointer.
- `suggestion_shortlists` holds only the latest successful ordered pool of at
  most 80 canonical refs. empty is a successful publication. metadata is hydrated
  from current facts; stored relevance age never grants access.

`suggestion_shortlist_refresh` runs on the existing serial background lane with
its normal three-attempt policy and `keep_dead=True`. its payload is `{feed_id}`.
admission is serializable and joins existing work. a read-only repeatable-read
snapshot captures the input revision, database time and ranking.
ranking holds shared search admission through snapshot cleanup and physical backend
retirement; queue wait consumes the existing database and worker timeout budgets.
a separate short serializable publication transaction locks the execution claim, verifies the
feed pointer and destination authority, replaces the publication, clears the
pointer and finishes the job atomically. a newer input revision remains visibly
dirty. workers never enqueue successors.

source changes record dirtiness even with no registered feed. only an active
observer requests work, for meaningful changes or the 15-minute age target.
later builds become available no earlier than the previous snapshot time plus
30 seconds. no queue completion deadline is promised.

## ports

both `/lectern/suggestions` and `/libraries/{library_id}/suggestions` expose:

- `GET`: `{observed_at, state, publication: {id, items} | null}`, the latest
  publication's currently eligible hydrated items. `state = {input_revision,
  latest: {id} | null, work: Queued | Running | Recovering | Suspended | null,
  capability: Available | LecternFull | NotApplicable, automatic_refresh: Now |
  At{at} | Stopped}`; an item's target is `Media{ref, media_summary, href}` or
  `Podcast{ref, title, subtitle, href}`.
- `POST /view`: reconcile up to 80 distinct supplied refs in their original
  order, independently of the latest publication. no ranking or admission.
- `POST /refresh`: no body; ensure-fresh admission only, 202 after commit.
  each request rechecks current need: retain existing work (including suspended),
  no-op for a fresh publication, otherwise enqueue one build. repeats can admit
  later work only when the then-current publication is due. ordinary ui refresh
  calls GET; only the observer requests background freshness.

`/stream/lectern/suggestions` and
`/stream/libraries/{library_id}/suggestions` expose `Current {state}` or terminal
`Withdrawn`. each reread reauthorizes. the global `nexus_suggestions` / `changed`
notification is a wakeup hint; durable revisions are truth. the comparison
payload excludes the moving observation clock. queue history hooks notify for
retry, reclaim and dead transitions; first claim is observed at the next existing
15-second stream reconciliation.

library deletion and loss of admin delete shortlist then feed. orphaned jobs
finish superseded. non-admin/system libraries expose no publication. a full lectern
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
