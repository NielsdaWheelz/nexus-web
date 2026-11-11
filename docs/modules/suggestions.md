# suggestions

suggestions propose what to put on the lectern or into a library; quick reads
are short unfinished documents; daily selection is a finite account-wide edition.
`services/suggestions.py` owns one closed selection policy, current eligibility
and hydration. `selection_context.py` owns bounded committed intent;
`daily_selection.py` owns account-calendar windows and publication-evidenced
admission. `services/suggestion_shortlists.py` owns admission, publication, reads
and the queue handlers.
`services/suggestion_changes.py` owns the input revision, the engagement gate and
feed deletion. web: `lib/useSuggestions.ts` (the visit model),
`components/collections/SuggestionsSection.tsx`, `QuickReadsSection.tsx`.
this module owns retrieval, admission and complete publication. [search](search.md)
owns shared admission, quality and progress; [deployment](../../deployment.md#capacity-contract)
owns aggregate physical resources. fixed scheduling intervals are not latency guarantees.

## product contract

- destinations: the lectern (every viewer) and each library the viewer admins,
  All included. member-only and system libraries have none (`NotApplicable`).
- suggestions eligibility, one predicate for ranking and delivery: on the lectern, a visible
  unfinished media not on it; in a library, a visible media it does not hold,
  through actual media placements, and for a named library a followed source it does not
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
- quick reads: lectern only, at most five visible unfinished documents with
  `0 < remaining_seconds < 600`. complete current reader publications prove
  duration; excerpt and unknown extent cannot qualify. in progress first, then
  lectern/context preference and current engagement/recency ties. this is a direct
  read without a semantic scan; display and ordinary actions stay unchanged.
- daily selection: at most five individual held media acquired in the previous
  account-local morning window, from currently followed sources or individually
  saved articles. history and pre-cutover unknown discovery are excluded. choose
  the earliest credible original publication fact across source occurrences and
  reader publications; never use import, update or model-enriched dates. timestamps
  qualify within seven civil days of cutoff; date-only values within the edition
  day and preceding six dates. a current readable publication, playable audio or
  authorized source link is required for initial admission.
- daily `/view` only checks existence, access, metadata and action capabilities.
  finishing, filing or unfollowing never replaces selected rows. retained visits
  remain independently readable after the server replaces its latest edition.

## context and ranking

contextual modes combine at most five canonical destination anchors with at most
five deduplicated recent intent anchors. daily uses account intent only. reading,
listening, accepted notes/highlights, individual saves and one latest complete
user message per conversation supply facts. assistant output, automatic arrivals,
unsynchronized writing and device-local opens do not. repeated actions do not add
votes. quoted readable media supply anchors; unquoted user text supplies lexical
evidence through search's exact-reading port, including body passages.
the discovery row's last individual-save timestamp supplies manual intent;
automatic/bulk acquisition cannot change it. its independent first-discovery
timestamp never moves and remains the daily admission clock.

graph evidence precedes shared authors, user-text lexical evidence and supported
stored-vector similarity. each lane retains its own strength order; canonical
identities break ties. recency supplies direct candidates, with a soft cap of two
per source, author, anchor, reason and kind before available alternatives are
exhausted. no provider calls or editorial prose are part of ranking.
daily gives its source cap precedence over the other soft preferences, across
all eligible arrivals; it chooses five before truncating alternatives. its source
is the lowest canonical feed id among authorized catalogue occurrences, independent
of current-follow admission; individually saved articles retain known source
identity after unfollowing. unknown sources stay null, without domain inference. suggestions
retains its existing twenty-per-family pool and soft-preference order.

## durable facts

- `suggestion_inputs` holds durable per-source clocks plus the migration-owned
  baseline. canonical writers pass their changed namespaced source identities to
  `suggestion_changes.record_input_change` in the source transaction; each clock
  advances once per call. sorted
  keys give multi-owner updates consistent lock order. only readers compute the
  sum; it includes late commits, and clock rows survive source deletion. unrelated
  writers do not share a singleton publication mutex.
- reading and listening advance it only when they move an anchor list or the
  read state. `engagement_gate`, taken before the write, reads the head of each
  anchor list the write can move (the lectern's, and each admin library's that
  holds the media or its show; a transcript save on an episode moves only the
  lectern's) and the read state; the write stamps the media's engagement now, so
  the anchors moved exactly when one of those lists was headed by something else.
- `suggestion_feeds` registers a viewer/mode/destination and points to its current
  job. a null library means lectern suggestions or the account's daily edition,
  distinguished by `mode`. dead work retains its pointer within the same due work.
- `suggestion_shortlists` holds only the latest successful ordered pool of at
  most 80 canonical refs. empty is a successful publication. metadata is hydrated
  from current facts; stored relevance age never grants access. daily adds its civil
  date, captured zone, immutable window and frozen head-coverage counts; suggestions
  carries null edition metadata. no edition archive exists.

`suggestion_shortlist_refresh` runs on the existing serial background lane with
its normal three-attempt policy and `keep_dead=True`. its payload is
`{feed_id, edition}`; edition is null for suggestions and a frozen window for daily.
admission is serializable and joins existing work. a read-only repeatable-read
snapshot captures the input revision, database time and ranking.
media anchors use their first chunk's current active vector; a piece uses its
first eligible admitted chunk. each selected anchor requests independent
graph-thread and rediscovery windows. sequential postgres queries score original vectors and
project canonical reading/chunk rows before ordering by distance, reading id and
chunk id and taking 400 per anchor/family; only then are rows grouped by media.
vectors and eligibility stay in postgres. there is no shared ann traversal or
all-anchor cross-product.
ranking uses the native async search gate with one finite
absolute allowance for checkout, nonblocking admission and the complete snapshot.
the [search contract](search.md#work-bounds) separates capacity waiting
from the execution allowance. background contention defers through the existing
job owner; browser capacity waiting belongs to the current client intent.
retirement confirms the search pid is absent before any publication transaction;
a known-unconfirmed backend prevents publication and fails that scope's search
capacity closed. there is no retained partial ranking across attempts.

only observed admission contention returns a same-job reschedule at database
`now() + 5 seconds`. normal queue settlement keeps
the payload and feed pointer and refunds the claimed attempt. each later attempt
reruns the entire read. setup and admitted computation expiry spend the ordinary
bounded failure budget. arbitrary `57014`, connection loss and shutdown retain
their own error or lifecycle handling. the deferral claim check and database-time read use one short ordinary
transaction after the search scope has closed. this sequential child handler has
no concurrent frame/provider/ordinary owner; the supervisor heartbeat is separate.
reschedule logs identify `admission_busy`; owned read expiry retains its error.

once the complete read and retirement succeed, a separate short serializable
transaction locks the current execution claim, verifies the feed pointer and
current destination authority, replaces the publication, clears the pointer and
finishes that same job atomically. lost/superseded claims cannot publish. failed
or deferred reads leave the prior publication intact. a later input revision
remains visibly dirty. workers never enqueue successors. the publisher may finish
its own job, so the outer worker need not emit another settlement event.

source changes record dirtiness even with no registered feed. an active suggestions
observer requests work for meaningful changes or the 15-minute age target.
later builds become available no earlier than the previous snapshot time plus
30 seconds. sustained competing activity may leave suggestions stale; observers
retain current publication and truthful queued/recovering/suspended state.

the existing periodic worker runs `daily_brief_due_job` every minute and ensures
each account's latest due edition without a client observer. cutoff is 07:00 in
`users.calendar_time_zone`; civil mornings handle daylight-saving boundaries.
after a zone change the window starts at the later of the nominal previous morning
and the prior successful cutoff. older cutoffs and captured old zones cannot
publish. missed editions are skipped; failed builds retain the dated prior result.
same-edition retries retain their budget, while a later due window supersedes old
work. first successful publication fixes the edition's order, including empty.

publication rechecks the claim, current pointer, current due window and account
zone under the account lock. successful daily publication enqueues at most five
linked-article preparations through the source owner, after the ranking read.
preparation accepts authorized feed links and individually saved article urls;
it never requests model enrichment or delays the edition. selection itself never
fetches. the minute sweep re-offers the same visible
nominations and edition attempt ids after an in-flight feed-body parse settles;
it neither rebuilds the edition nor resets an extraction's retry budget.
frozen coverage counts only current followed sources with no pending head whose
latest head check succeeded without gaps no earlier than one hour
before cutoff. archive runs do not count. partial coverage is visible even with
rows; complete empty editions say `no eligible items today.`.

qualification freezes the active due-feed cohort and a finite observation window
before work begins. every due feed must publish the settled input within that
window after competing work drains. pre-existing suspended failures are identified
at the start; failures created by the workload are not exempt. there is no
quiet-period latency target or promise of freshness during sustained activity.
heavy work may queue behind other work, then must resume and drain; simultaneous
peak execution is not required. backup-window enforcement is not required by the
current prototype acceptance. idle normal
services and retained memory remain part of capacity accounting.
backend retirement, useful publication and the resource envelope remain separate
obligations under the [search contract](search.md#qualification-contract).

## ports

`/lectern/suggestions`, `/libraries/{library_id}/suggestions` and `/daily-brief` expose:

- `GET`: `{observed_at, state, publication: {id, edition, items} | null}`, the latest
  publication's currently eligible hydrated items. `state = {input_revision,
  latest: {id} | null, work: Queued | Running | Recovering | Suspended | null,
  capability: Available | LecternFull | NotApplicable, automatic_refresh: Now |
  At{at} | Stopped}`; an item's target is `Media{ref, media_summary, href}` or
  `Feed{ref, feed_id, feed_kind, title, subtitle, image_url, href}`. podcast refs
  and routes keep their existing identity; article sources use feed refs.
- `POST /view`: reconcile up to 80 distinct supplied refs in their original
  order, independently of the latest publication. daily accepts at most five
  media refs. no ranking or admission.
- `POST /refresh`: no body; ensure-fresh admission only, 202 after commit.
  each request rechecks current need: retain existing work (including suspended),
  no-op for a fresh publication, otherwise enqueue one build. repeats can admit
  later work only when the then-current publication is due. ordinary ui refresh
  calls GET; daily refresh only ensures a missing due edition, never rebuilds one
  that completed. daily read capability is independent of lectern capacity.

presented foreground consumers read every 30 seconds, or every 10 seconds while
state is `Queued`, `Running` or `Recovering`; `Suspended` does not poll fast.
before pool adoption they use GET; afterward read-only `/view` preserves the
adopted pool and ranking while reconciling current eligibility and server time.
return and local actions revalidate immediately. polls never request `Refresh`.
there is no suggestions stream or notification producer.

library deletion and loss of admin delete shortlist then feed. orphaned jobs
finish superseded. non-admin/system libraries expose no publication. a full lectern
keeps browsable suggestions; its capability separately disables new additions.

## operator repair

diagnose and fix the recorded queue failure first. source changes and navigation
cannot bypass dead work. a later daily window supersedes it; the same window
retains its budget. identify the feed's `current_job_id`, inspect
that row and its `execution_id`, `error_code`, `last_error` and result, then use
the existing same-job repair in the intended environment. this grants one fresh
budget; it does not replace the job or discard the last publication.

```python
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.jobs.queue import get_job, requeue_dead_job

job_id = UUID("the-diagnosed-job-uuid")
with get_session_factory()() as db:
    job = get_job(db, job_id, lock=True)
    assert job is not None and job.kind == "suggestion_shortlist_refresh"
    assert db.scalar(text(
        "SELECT EXISTS (SELECT 1 FROM suggestion_feeds WHERE current_job_id = :id)"
    ), {"id": job_id})
    requeue_dead_job(db, job_id=job_id)
    db.commit()
```

the queue repair commits normally. a job already repaired is unchanged. confirm
the same still-current job publishes successfully and its feed
pointer becomes null; do not delete a dead row to obtain another attempt budget.
