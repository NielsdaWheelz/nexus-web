# suggestions publication plan

status: implemented; product decisions confirmed 2026-10-14.
[verification](suggestions-verification.md) records the live red/green/refactor
campaign, final artifact, limits and cleanup. deployment is separate.

publish ranking outside the read path; serve current eligible choices without
waiting for computation. [production observations](tickets/synapse-slate-query-plans-unmeasured.md)
show 6.6–16.2 second suggestions responses; quick reads examine a much smaller corpus.

## target and scope

- lectern and library suggestions share one published-shortlist system. retain
  the current exact, model-free relevance policy. quick reads keep their direct
  query, response shape and behavior.
- render the section immediately. serve the last successful shortlist without
  ranking or waiting for a worker. before first publication, show preparation;
  distinguish successful empty output, read failure and suspended work.
- check current authority, visibility and destination eligibility on every read
  and independently in every add command. ranking may age; eligibility is true
  at the read snapshot, not guaranteed unchanged after response delivery.
- preserve displayed order during a visit. stage replacements until “show new
  suggestions” or pane revisit. acknowledged additions disappear immediately;
  refill from the adopted pool without a network dependency.
- record meaningful changes durably. admit ranking only for an active, visible
  destination, on changes, explicit refresh or the 15-minute age target.
  admitted work finishes after the pane closes. no completion deadline is
  promised: the existing background lane is serial and cannot preempt ingestion.
- full lecterns retain browsable suggestions and disable fresh additions.
  unresolved “check add” recovery remains available. library suggestions do not
  wait for entry pagination.

non-goals: new recommendation policy, approximate vector search, new models,
worker capacity, scheduler, event bus, snapshot history, offline suggestions,
cross-feature transport migration, or repairing the broader semantic-search
and graph-query tickets. no fallback ranker, compatibility path or feature flag.

## owners and storage

reuse postgres, the existing queue/fence, snapshot sse, generated wire types,
compact target hydrators, collection presentation, and destination add owners.
one new service, `services/suggestion_shortlists.py`, owns admission, publication,
bounded reads and the worker handler. `services/suggestions.py` owns ranking.

| table | columns and meaning |
|---|---|
| `suggestion_inputs` | `id uuidv7 pk`, `created_at timestamptz`, `revision bigint`; exactly one row seeded by the migration |
| `suggestion_feeds` | `id uuidv7 pk`, `user_id fk`, `library_id nullable fk` (absence means lectern), `created_at timestamptz`, `current_job_id nullable fk background_jobs` |
| `suggestion_shortlists` | `id uuidv7 pk` identifying this publication, `feed_id unique fk`, `created_at timestamptz`, `ranked_at timestamptz`, `ranked_revision bigint`, `target_refs jsonb` |

the input counter exists independently of feed registration. otherwise a source
transaction can miss a concurrently created feed and let its first publication
appear falsely clean. use a singleton read/assertion, never lazy self-repair.
do not put this counter on `users`: consumption already locks user then reader
publication, whereas source publication can hold those locks in the opposite order.

the feed records a requested destination, including before any successful
ranking. enforce one feed per user/destination, including one null-library feed
per user. the shortlist exists only after success; `[]` is a valid publication.
replace it atomically, assigning a fresh publication id. retain no history.
`target_refs` is an owned ordered array of at most 80 distinct canonical media
or podcast refs; validate at its boundary. store no hydrated metadata, capability,
status, duplicate dirty flag or error. derive dirtiness from revision comparison
and execution state from the referenced queue row.

use normal non-cascading foreign keys and explicit cleanup: delete shortlist,
then feed, before deleting its user/library. lost destination authority withdraws
its observations; orphaned work settles superseded under its claim fence.
follow [database](rules/database.md), [lifecycle](rules/resource-lifecycle.md)
and [jobs](modules/jobs.md) rules; add no business-invariant triggers or checks.

## refresh and publication protocol

1. **admit:** one fresh serializable transaction authorizes the destination and
   finds/creates its feed. join `current_job_id` if present, including dead work.
   otherwise enqueue one fresh `suggestion_shortlist_refresh` job carrying only
   `feed_id`, and set the pointer. automatic admission requires missing, dirty
   or 15-minute-old publication. explicit refresh may refresh a clean publication.
   use the existing serialization retry owner and handle the first-insert
   uniqueness race. no permanent destination dedupe key or extra owner lock.
2. **bound work:** first preparation is immediately eligible. later builds start
   no earlier than the previous publication's `ranked_at + 30 seconds`.
   queued/running/retrying work coalesces all further requests without resetting
   its budget. this bounds event bursts; it deliberately permits up to 30 seconds
   of additional relevance delay.
   enforce the bound with queue `available_at = max(db_now, ranked_at + 30s)`.
3. **invalidate:** after all domain reads, writes and locks, flush pending orm
   changes, increment the global input counter, notify, then commit. do no further
   domain work after taking the counter. this atomically records changes even
   without feeds and avoids lock inversion. every qualifying change dirties all
   destinations; source commits briefly serialize here. neither feeds nor jobs
   are created. no dependency graph or generic commit-hook framework.
4. **compute:** in one read-only repeatable-read snapshot, capture the global
   input counter and database time, then rank. produce the existing first ten exactly;
   extend to 80 using the same accumulated diversity counts and ordering.
   merely changing `_rotate(..., limit=10)` to 80 can change the first ten and is
   forbidden. remove the full-lectern early-empty shortcut. quick reads stay intact.
5. **publish:** in a short serializable transaction, acquire
   `lock_running_job_claim`, verify `current_job_id`, recheck destination authority,
   replace the shortlist, clear the pointer and call `finish_job` atomically.
   reclaimed executions publish nothing. a newer input revision does not
   discard useful completed work; publish its captured revision and leave the
   difference visible. the active observer admits a successor. the worker never
   admits one itself.
   if authority is lost, clear this job's matching pointer and finish superseded
   atomically; retain the hidden publication. a missing feed only finishes
   superseded. never leave a succeeded job referenced by a feed.
6. **repair:** use the existing retry policy and `keep_dead=True`. dead work
   retains its pointer and last publication. navigation, age and newer inputs
   cannot grant another budget. diagnose/fix the cause, then operator repair
   uses `requeue_dead_job` on the same job. no automatic “unstick” or product
   retry that bypasses a defect.

source hooks must cover these actual ranker inputs, including non-browser writers:

| input | integration owners under `python/nexus/services/` |
|---|---|
| ordered anchor identities; finished/unread/reset transitions | `consumption/{activity,service,lectern,listening,reader_cursor}.py`, `library_entries.py` |
| membership, visibility, destination authority and deletion | `library_entries.py`, `library_governance.py`, `library_sharing.py`, `resource_grants.py`, `resource_sharing.py`, user/media teardown owners |
| highlights and note anchors | `highlights.py`, `pdf_highlights.py`, `notes.py`, note/page mutation owners |
| graph evidence, including removal | `resource_graph/{edges,cleanup,links,highlight_notes,citations}.py` |
| author/publication facts and active embeddings | `contributor_writes.py`, `contributors.py`, metadata publication owners, `content_indexing.py` |
| podcast subscription and episode facts | `podcasts/{subscriptions,sync,ingest,backfill}.py` |

shared helpers detect meaningful changes; the committing owner increments once,
last. inventory both the detection and commit owner for each actual write;
demonstrate a covered path. compare ordered anchor identities before/after engagement;
repeated progress on the same anchors does not dirty ranking. keep the global
`Consumption` signal for other views. time-dependent relevance reconciles through
the age target. notification is a wake-up hint; revisions are durable truth.

## capability and api contract

existing route prefixes are `/lectern/suggestions` and
`/libraries/{library_id}/suggestions`; browser bff paths add `/api`.
use `Data[...]`, `CamelOut`, generated wire types and owned `Presence`.
the following are schema definitions, not additional handwritten web types:

```text
publication_meta = { id: uuid, asOf: instant, inputRevision: integer }
capability = Available | LecternFull | NotApplicable
automatic_refresh = Now | At { at: instant } | Stopped
state = {
  inputRevision: integer,
  latest: Presence<publication_meta>,
  work: Presence<DurableExecutionPhase>,
  capability,
  automaticRefresh: automatic_refresh
}
read = { observedAt: instant, state,
         publication: Presence<publication_meta & { items: SuggestionItemOut[0..80] }> }
view_input = { refs: distinct canonical target refs[0..80] }
view = { observedAt: instant, state, items: SuggestionItemOut[0..80] }
refresh_input = EnsureFresh | Explicit { observedPublicationId: Presence<uuid> }
```

| endpoint | contract |
|---|---|
| `GET <prefix>` | pure read of latest publication; bounded eligibility/hydration; no registration, ranking or enqueue |
| `POST <prefix>/view` | read-only reconciliation of client-retained refs; preserve supplied order, remove ineligible targets, hydrate the entire surviving pool; no ranking, admission or intersection with the latest publication |
| `POST <prefix>/refresh` | authorize and coalesce; return 202 `Data[state]` after admission, never after computation; explicit refresh only admits if the observed publication is still current, making repeated delivery safe |
| `GET /stream/lectern/suggestions` or `/stream/libraries/{library_id}/suggestions` | authenticated snapshot/diff stream; payload is `Current { state } \| Withdrawn`; the existing tailer emits terminal `Withdrawn` as both `state` and `done`; clear content on either |

in one get response, `state.latest` and publication metadata agree. `asOf` is
`ranked_at`, not publication/attempt time. absent feeds still report the global
input revision, no publication/work and `Now`. while work exists or capability is
inapplicable, advice is `Stopped`; otherwise missing means `Now`, dirty means
`At(ranked_at + 30 seconds)`, clean means `At(ranked_at + 15 minutes)`.
these instants are stable, even when already past. full capacity does not stop
ranking. explicit admission respects the same 30-second bound.

read authority before revealing any refs or state. inaccessible/deleted scopes
retain existing authorization/not-found responses. readable system/non-admin
libraries return `NotApplicable` without content. candidate refs are hints, never
authority. apply these predicates to the bounded supplied/stored set:

| destination | current candidate eligibility |
|---|---|
| lectern | visible media, unfinished, outside complete lectern membership; capacity is a separate capability |
| ordinary library | admin of non-system library; target outside complete destination membership; media visible; podcasts visible and actively subscribed |
| default library | same library authority/membership rules, media only |

library suggestions do not inherit lectern's finished exclusion. use existing
membership/visibility predicates, `engagement_fact_rows_sql(media_ids_param=...)`
and compact hydrators. no corpus embedding/graph acquisition in get/view paths.
an old adopted pool remains independently reconcilable after a newer publication
overwrites it. a depleted pool may show fewer than ten; never synthesize padding.

subscribe before the initial stream reread; reauthorize on every reread. use
`open_sse_listener`, `tail_snapshot_stream` and `sseClientDirect`. keep
`observedAt` OUT of the stream comparison payload, or every keepalive becomes
a false change. initial unauthorized requests retain ordinary http errors;
later scope loss returns `Withdrawn`. admission/publication/repair notify in their
own transactions. add an import-light `on_history` hook for retry/reclaim/dead
changes; queue worker notifications do not serve this stream. first claim may
be observed on the existing tailer's next 15-second reconciliation. queued and
running use the same copy; no new queue hook or polling loop is needed for start.

## browser behavior and content

one narrow suggestions hook owns the adopted hydrated pool, displayed refs,
staged publication, observation/admission errors and active subscription/timer.
render at most ten: retain eligible displayed survivors in their order, then
append unused eligible adopted-pool members. stage newly published pools;
identical eligible ordered refs update freshness silently. metadata-only changes
do not announce new suggestions.

with no adopted publication, install the first successful publication
automatically, even if empty. an adopted empty publication counts as adopted;
later replacements follow normal staging. a fresh get already validates its pool.

on accepted add, remove its ref and refill in one local state update. exclude
acknowledged refs from the adopted pool and any request begun before the receipt,
including staged-pool reads. fence results by destination and adopted publication;
coalesce one subsequent reconciliation
when changes arrive during a read. `Retained` preserves the existing destination
owner's unresolved-command recovery; confirmed “check add” also removes the row.
keep row controls mounted through reconciliation. refresh alone does not disable
them; current capability and the command owner decide availability.

revisit means a new pane visit or inactive-to-active transition, not window focus
or visibility recovery. before adopting previously staged data, reconcile its refs through `/view`;
retain current rows until it succeeds. late revisit data may auto-adopt only
before the user interacts with the section; otherwise stage it.
focus/visibility recovery reconciles current rows. close observers and the
one-shot age timer while inactive/hidden. schedule server advice from http
`observedAt` plus monotonic elapsed time since receipt, not browser wall time or
a restarted full delay. no interval poll.

input-revision changes reconcile the adopted pool; publication-id changes fetch
and stage the latest pool; work-only changes update status. older http responses
must not overwrite newer observation state. existing pane refresh submits
`Explicit { observedPublicationId }`, reconciles, and reports “refresh requested”;
it neither awaits ranking nor installs a replacement.
failed admission stops automatic resubmission from unchanged advice; retry the
same command explicitly or reconcile on a later visit. observation may discover
that the lost-acknowledgement command already committed.

the content designer owns this complete vocabulary and verifies it in the live ui:

| condition | visible content and action |
|---|---|
| first transport read | “loading suggestions…” |
| no publication, admitted work | “finding suggestions…” |
| successful empty pool | “no suggestions right now.” |
| existing publication refreshing | retain rows; “updating suggestions…” |
| changed publication staged | “new suggestions are ready.” / “show new suggestions” |
| read or observation failure | “couldn’t load suggestions.” or “couldn’t check for new suggestions.” / “retry” the read/observation |
| admission failure | “couldn’t request suggestions.” / “retry” the same conditional command |
| suspended durable work | “suggestions need repair.”; retain usable rows; preserve the operational defect and its diagnostic identity, no fresh-work retry |
| full lectern | “lectern is full. remove an item to add another.”; retain links and uncertain-command recovery |

headings: “suggestions” / “suggested for this library”. reuse existing target
titles, summaries and image treatment. add no generated recommendation prose,
scores, progress percentages or worker jargon. announce first completion, new
availability, explicit adoption and actionable errors once while active; no
refresh announcement loop. use existing collection focus repair only when the
removed control still owns focus at completion. otherwise leave focus alone.
if adoption removes its focused “show new suggestions” button, move focus to the
persistent section; otherwise preserve focus. keep that section at zero rows.

## delivery deadline

add one opt-in logical-operation deadline to shared transport: suggestions get
and read-only view have 10 seconds TOTAL through headers, body consumption and
retry waits, with at most three existing-policy early transient attempts. never
restart the deadline per attempt. exhaustion is `E_UPSTREAM_TIMEOUT`; caller
cancellation stays `AbortError`; auth, 4xx and same-system defects do not retry.
manual retry begins a new budget. refresh admission also ends within 10 seconds;
repeat the same conditional input if its acknowledgement is lost.

retain bff abort/deadline ownership until the selected json body closes, errors
or is cancelled; use a body-lifetime wrapper, not wholesale buffering. keep the
500ms server-bootstrap override for cheap published reads. other page budgets,
ordinary mutations, stream tokens, sse lifetime and media transfers remain
unchanged. delivery cancellation does not prove database work stopped and never
cancels the independent ranking job. name all three timing constants in their owners.

## implementation boundaries and review gates

each file has one owner. work can run in parallel after the wire/storage contract
is frozen; integration changes return to that file's owner.

| work package | exclusive files | adversarial gate |
|---|---|---|
| a: ranking, storage, api | `services/suggestions.py`, new `services/suggestion_shortlists.py`, `db/models.py`, `db/retries.py` (named insert-race constraints), one next-head migration, `jobs/registry.py`, `schemas/suggestions.py`, routes `lectern.py`, `libraries.py`, `stream.py`, `wire_schema.py`, generated `wire.gen.ts` | systems reviewer proves publication/claim/revision races and exact first-ten preservation |
| b: source integration and cleanup | mutation owners above; new import-light `services/suggestion_changes.py` owns counter update, notification, queue history hook and cleanup helpers | backend reviewer enumerates commits, counter-last ordering, heartbeat suppression, withdrawal and teardown |
| c: interaction and content | `SuggestionsSection.tsx`/css, new suggestions hook, `lib/suggestions.ts`, suggestion resource descriptors/loaders, lectern/library pane adapters | designer owns every state/copy row above; ux reviewer attacks order, focus, cold/empty/full/error and lost acknowledgements |
| d: transport | `lib/api/{client,retryPolicy,proxy,server}.ts` | transport reviewer proves total budget and unchanged mutation/stream/media semantics |
| e: verification | disposable external harness; `docs/suggestions-verification.md` and its sanitized receipts | independent reviewer checks red failures, real final flows and cleanup |

split quick-read typing from the changed suggestions envelope. remove old
request-time builders from suggestion routes, per-add full refetch, refresh
counters/facts keys, inactive-pane reads, hidden empty/loading branches and the
library `list.complete` mounting gate. retain shared ranking/hydration used by
quick reads. do not rewrite unrelated shared components or queue infrastructure.

seed library metadata, canonical first-page entries and published suggestions
independently under their existing resource keys. load them concurrently; a
named prefetch miss discards only its own seed. keep the existing 500ms budget
and error policy. filtered entry queries cannot consume the canonical seed as
their result. this adds one cheap server read, avoiding a second browser round
trip and preventing entry acquisition from hiding completed sibling resources.

## acceptance and red green refactor

use a disposable production-shaped database and the ordinary browser → bff →
api → worker path. source/image/schema/fixture identities belong in the receipt.
temporary live tests are explicitly requested for this change; they do not alter
the permanent static-only [verification contract](local-rules/testing-standards.md).

| proof | acceptance |
|---|---|
| visible first load | heading/state renders before suggestions response; missing, empty, read failure and suspended work are distinct; library entry pagination cannot gate them |
| serving cost | after publication, 20 recorded reads per surface plus three concurrent views: api p95 ≤500ms and browser rows ≤1s on the declared production-shaped setup; no request-path similarity/whole-graph acquisition; record queue/build time separately |
| ranking/content | fixed-snapshot first ten match the old ranker for lectern, ordinary/default libraries; quick reads unchanged; designer checks metadata, copy, keyboard focus and 320px/enlarged-text layout |
| freshness/coalescing | independent writers dirty inactive feeds without jobs; active view admits once; repeated same-anchor heartbeats admit none; age, explicit refresh, event bursts and reconnect obey advice; successful empty pools never trigger refill loops |
| publication races | overlap a source commit with first feed registration and with reader publication; pause/reclaim/fail workers; obsolete attempts cannot publish, newer inputs remain dirty, inactive completion admits no successor, dead work retains its owner until same-job repair |
| stable view/current facts | display a, publish b, change eligibility, then adopt b; revalidate both independently, including add during adoption; eligible a survivors retain order; full capacity keeps links; acknowledged add/refill is immediate even with subsequent network blocked |
| delivery and lifetime | real pre-header and mid-body stalls end within 10s plus ≤1s scheduling tolerance; early retries share budget; navigation cancels; sse/media beyond 10s and existing uncertain-add recovery still work |
| authority/teardown | unauthorized refs never hydrate; revoked/deleted scope clears rows; revoke during computation then restore without a stuck completed-job pointer; explicit cleanup leaves no blocking fks; worker orphan settles |

first expose each regression independently on the baseline; an unavailable new
endpoint cannot stand in for the behavioral red. implement, pass the cases,
refactor to the rules, then rerun affected cases on the final built artifact.
faults delay/drop real transport or control the ordinary worker; no fabricated
successes, production test seams, auth bypass or unbounded benchmark campaign.
run `./scripts/test`, retain concise receipts and limitations, delete only
manifest-owned tests/fixtures/dependencies/resources, then rerun the unchanged
static gate. surviving evidence is documentation, not a hidden test suite.

## cutover and explicit costs

deploy matching api/worker/web with the normal migration controller; reload old
clients. start with no fake publication; the first normal refresh creates it.
verify both surfaces and quick reads on the exact deployed revision. remove
resolved tickets only after proof; retain wider graph/search/transport issues.

the costs are deliberate: three small tables instead of the initial one-table
estimate, including a shared input counter that briefly serializes source commits
and invalidates all destinations; up to 80 compact hydrated targets per read;
bounded stale relevance and possible cold queue wait; up to 30 seconds event
coalescing delay; inactive destinations refresh on return; dead work needs live
operator repair; no historical publication retrieval; 10-second protection is
limited to suggestions. deleting the temporary tests removes future automated
regression detection; receipts and static checks remain. none of these costs
permits stale authority, hidden failures or alternate legacy behavior.
