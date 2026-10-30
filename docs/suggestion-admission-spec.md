# suggestion retrieval and search admission

this specification owns exact candidate domains, ranking, admission and complete
publication. [search reliability](search-reliability-spec.md) owns the common
resource, quality/progress and release acceptance contract;
[database capacity](database-capacity-spec.md) owns physical topology/accounting.
there is one integrated repair, not a required database-pr/search-pr split.

## outcome and evidence

background refresh and foreground search must complete useful work inside the
fixed envelope. heavy work may queue and serialize, including an enforced backup
window; ordinary reading, local writing and control work remain usable, and
finite queued work must drain. normal services count even when idle. the selected
baseline is exact original-float retrieval. no approximate path is required merely because
an earlier plan permitted it, and no faster graph-only result substitutes for a
working semantic lane.

the october 26 holder and captured-query investigation established minutes of
admission occupancy, readiness misestimates and spills. its emulated one-anchor
and censored five-anchor timings remain diagnostic history in
[the issue](issues/production-search-admission-contention.md), not current timing
acceptance. later selected 0321 warm component publication/coexistence succeeded;
later mixed backup-overlap memory work failed. the
[common evidence record](search-reliability-spec.md#evidence-and-uncertainty)
preserves each source, package, schema, limitation and failed verdict. integrated
migration, cold/full-topology progress and release proof remain open.

## exact domain and ranking

`services/suggestions.py` owns relevance/eligibility;
`content_indexing.py` owns canonical reading/chunk membership and readiness;
`search/semantic.py` owns common vector scoring; `search/admission.py` owns
admission/retirement; `suggestion_shortlists.py` owns claims and publication.
keep policy at those owners rather than adding a ranking or scheduling layer.

one read-only repeatable-read snapshot captures ranking time, input revision,
all original anchor ordinals, current eligible anchors and destination membership.
scope, permissions, self-exclusion, readiness and active provider/model/dimension
apply before selection. preserve original vectors, calibrated similarity 0.80,
anchor attribution, family composition, evidence precedence, rotation and
diversity. browser/strict distance 0.5 and oracle's full 0–2 domain remain separate
consumer contracts; this repair does not tune them.

for every original eligible media anchor, choose one first admitted current
chunk by the canonical order, including source/piece and immutable capture
membership. a reading with both own text and capture occurrences must not acquire
two anchor vectors through overlapping branches. preserve original ordinals even
when other anchors do not enter this semantic path.

for each anchor and each `GraphThread`/`Rediscovery` family:

1. admit the complete canonical destination reading/chunk relation, including all
   eligible bounded pieces and repeated capture occurrences, with current-ready
   active-model vectors.
2. score original stored vectors, apply the existing threshold and self-exclusion,
   and order by distance, reading id and chunk id.
3. retain at most 400 **reading/chunk rows**, then group by media with the existing
   minimum distance and anchor/family attribution.

a unique-chunk cutoff followed by reading projection is not equivalent, even for
an exact chunk reader. include the 401-equal-distance/overlapping-reading boundary
in comparison evidence. a universal truncated-neighbor adapter is not required.
sequential queries in one snapshot replace the old all-anchor cross-product;
they must still complete the full refresh, not only a favorable anchor.

keep eligibility and scoring in postgres and return only bounded winners; do not
export a complete vector domain to python. positive readiness comparisons retain
`(lexical_revision = revision) IS TRUE` and its existing statistics. use actual
plans and exact reference outputs when changing query shape; bounded output alone
does not bound join, sort, temporary or maintenance memory.

approximation is considered only if the exact baseline fails capacity or useful
coexistence and an owner approves one alternative. the reliability contract's
unchanged browser/suggestion recall floors and review of every changed first-page
ref still apply. permissions, reading boundaries, model/publication identity,
original-vector threshold and retained-candidate attribution stay exact. no
runtime fallback, adaptive recall, dropped anchors/families or hidden underfill.

## operation and admission

all expensive callers use the native async admission owner: browser discovery,
strict tools, pickers, oracle, connection discovery and shortlist ranking.
preserve each caller's direct/short-query bypass, embedding failure semantics,
outer deadline and cancellation ownership. browser requests admit before
embedding; background/tool provider work keeps its existing owner outside
admission. no ordinary transaction is held while waiting for search/providers.

physical checkout precedes the one database-wide session advisory gate and is
charged to the capacity owner's finite allowance. browser requests refuse
occupied capacity instead of waiting inside their request clock; current client
intent owns waiting and automatic retry outside execution time. background
admission also refuses contention, using normal durable job deferral.
the required execution allowance begins at admitted execution and is never spent
on capacity queue waiting or reset during the read/result construction. waiting
remains honestly pending and resumes under the current intent; generic copy is
sufficient. remaining statement timeout must back the admitted read after
admission-transaction rollback.
the foreground waits for admitted background work; background refuses observed
local physical-permit or advisory-gate contention without waiting. the try-lock
cannot jump foreground waiters already queued in postgres. there is no additional
priority service, idle detector or persistent deferral store.

retain the physical lease until driver work is joined and the captured backend
is confirmed absent. unconfirmed retirement fails that scope's search capacity
closed and prevents publication. slow confirmed cleanup alone does not reject an
otherwise live successful result; actual cancellation/expiry still wins. never
unlock early or abandon cleanup to satisfy a stopwatch.
transient control-connection loss during database recovery retries only that
confirmation within its existing window. a disconnected read or known blocked
search scope is a settled search failure, not contention or a workspace defect;
it never automatically replays the query.

only observed admission refusal returns the existing database-time `+5 seconds`
same-job `RescheduleRequested` with an attempt refund. setup failures and admitted
computation expiry spend the ordinary bounded failure budget. generic pre-read
expiry is not observed contention; arbitrary `57014`, shutdown, lost claims and
database/invariant errors keep their existing classifications. no retry-to-green,
new queue or hidden perpetual rescheduling.

finite watchdog values must permit complete work and finite queued foreground
completion under the chosen serialization policy inside actual browser/bff/platform
ceilings, as required by the reliability contract. the former 400 ms computation,
500 ms occupancy/retirement and
60-second quiet-publication acceptance gates are retired. no replacement numeric
latency deadline is approved. diagnostic expiry is censored noncompletion.

## publication and observed feeds

after complete materialization and confirmed retirement, the existing short
transaction rechecks the execution claim, feed job identity and authority,
replaces the complete pool, clears the pointer and settles that same job
atomically. prior publications survive failed, deferred or lost-claim work.
never publish a partial or fabricated-empty replacement.

`ranked_revision` truthfully records the read snapshot; it need not equal a newer
input at publication. reject no otherwise complete build merely because inputs
changed while it ran. instead retain dirtiness and prove later convergence.
freeze the active due-feed cohort before qualification; after finite competing
work/mutations drain, every such feed publishes the settled revision within the
predeclared finite observation window. case-created failures/suspensions cannot
remove a feed from acceptance. repeated rescheduling and old rows fail progress.

preserve [stable visits and explicit refresh](modules/suggestions.md): an adopted
pool keeps its order, current eligibility is rechecked, and ordinary refresh
reads the latest completed publication without waiting for ranking. the
15-minute age policy and 30-second build spacing are scheduling policy, not
freshness or completion guarantees.

## qualification and costs

freeze exact references and cases before tuning: full nonempty five-anchor
semantic work, both families, global/library/source/piece/capture scopes,
semantic-positive restrictive cases, genuine empty results, active-model changes
and deterministic cutoff ties. preserve literal evidence and real activation.
qualify normal claim/heartbeat/result/publication, contention, cancellation,
withdrawal, lost claims and failure budgets alongside useful lexical/hybrid
completion, writing, controls and finite queue drain. simultaneous heavy peaks
and backup overlap are not required; retained memory and reachable maintenance
demand remain inside the unchanged envelope.

account for repeated eligibility work, longer snapshots/gate holds and retained
physical waiters under the same native resource envelope. no larger host or
memory quota, partial-ranking store, exhaustive fallback or feature cut is
authorized by a failed qualification. explicit bounded recall loss is a cost
only of an approved approximate alternative.

use the common acceptance/release gates and existing
[verification owners](local-rules/testing-standards.md). a historical query replay,
one component, a fake-provider composition pass or static consistency does not
qualify the current full native corpus. no new suite, runtime or automatic
production failure reproduction is required.

issue owner: [admission contention](issues/production-search-admission-contention.md).
mechanism reference: [pgvector filtering](https://github.com/pgvector/pgvector#filtering).
