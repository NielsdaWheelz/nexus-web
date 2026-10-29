# suggestion retrieval and search admission

investigated planning draft, 2026-10-28; pr 3 of the release repair scope.
published for review at the owner's request. specification only. the existing
[search reliability plan](search-reliability-spec.md) records retrieval, admission,
quality and liveness decisions. the owner's latest simplicity clarification keeps
the behavioral budgets and permitted recall trade-off, while reopening detailed
implementation means. start with the smallest query/admission repair that meets
the complete contract; an allowed approximate ranking is not a requirement to
replace a qualifying exact query. reconcile chosen mechanics into that plan
before implementation.

source investigation at `96a3b7bdf` establishes the call topology and feasibility
gate below. no native query replay or timing was run in this pass; the full
five-anchor occupancy/quality conjunction remains unproved.

## outcome and known evidence

background refresh must complete useful work without monopolizing foreground
search. `suggestion_shortlists.run_suggestion_refresh_job` holds `search_session`
through ranking/materialization; `suggestions._media_neighbor_rows_sql` computes
an exhaustive vector cross-product. the database-wide session lock is retained
until physical backend retirement.

on october 26 an identified background holder occupied the exact search gate for
minutes before its 300-second statement timeout. an isolated captured-query
replay found underestimated readiness joins, large intermediate work and spills;
one anchor took 5.18 seconds and five exceeded a 15-second diagnostic cap. these
emulated measurements do not establish native performance. current foreground
semantic retrieval already has cardinality-routed exact/approximate selection.

current `reading_chunks_sql` now includes an x-capture branch as well as whole
media and bounded-piece branches. the old 0317 captured query is useful incident
evidence, not the complete candidate query or current eligibility oracle. compare
the revised source on the current migrated corpus before making release claims.

## owners, scope and invariants

- `services/suggestions.py` owns candidate semantics;
  `content_indexing.py` readiness joins; `search/semantic.py` common neighbors;
  `search/admission.py` admission and cleanup; `suggestion_shortlists.py` claim,
  refresh and atomic publication. preserve the quiet suggestion presentation.
- first compare exact outputs/plans after positive readiness predicates match
  the existing `(lexical_revision = revision) IS TRUE` statistic. that narrow
  candidate has not yet been qualified for the captured suggestion statement.
- the existing plan permits approximate semantic candidates, with per-case
  overlap `>= ceil(0.9 * min(10, old_count))` and review of changed first-page refs.
  permissions, piece boundaries, publication/model identity, threshold and
  retained-candidate attribution remain exact. no silent extra recall loss.
- preserve one coherent ranking snapshot and atomic claimed publication; no
  partial or fabricated-empty publication. providers stay outside admission.
  cancellation joins backend retirement before releasing capacity.

## verified callers and interface

| existing synchronous gate caller | natural boundary if async conversion is needed |
| --- | --- |
| `suggestion_shortlists.run_suggestion_refresh_job` | one loop/scope for the bounded read phase; retire backend before the existing claimed publication transaction |
| `search.service.search`, used by `connection_discovery._scan` | `_scan` is already async; use `search_scopes_async`, preserve its strict evidence contract and background completion |
| `oracle.readings._prepare` | `_run` is already async; preserve the pre-provider commit and caller snapshot, await embedding/retrieval with its reviewed foreground budget |
| `search.pickers.search_targets` | async route/cancellation owner; direct-id and short-query paths stay ordinary bounded reads; semantic path gets its own original deadline |

browser `search.discovery` already uses async admission. strict tool retrieval
already has an async entry but wraps synchronous embedding in a thread. the
shared embedding change must preserve each caller's failure semantics and join
cancellation, not merely rename a function. no provider call belongs inside the
search lock or an ordinary transaction retained while awaiting search.

pr 2 supplies a finite physical bound, safe loop behavior and ordinary capacity
responses; no new pool matrix or scope api is assumed. pr 3 owns search
deadlines/purpose and the
physical backend's retirement under the session lock. one absolute deadline
includes checkout and lock waiting; apply the remaining statement timeout after
the admission transaction rollback. no new ordinary/control pool inside pr 3.
final acceptance is joint with [pr 2](database-capacity-spec.md#boundary-agreed-with-pr-3).

publication already checks current job claim, feed job identity and authority in
a later short transaction. `ranked_revision` records the read snapshot; it is
not an equality check against the newest input at publication. preserve that
truthful stale-publication behavior under concurrent changes and prove a fresh
publication after the quiet interval; do not silently add stricter invalidation
that can starve every completed refresh.

## next specification work

first measure the readiness-predicate repair and complete existing ranking.
keep that executor if it satisfies the fixed quality, occupancy and progress
requirements. if it does not, the existing common-neighbor adapter is the next
candidate. retain one shared admission owner; change callers only as necessary
to provide bounded admission, real cancellation and joined backend retirement.
agree pr 2's physical-checkout contract without prescribing its pool machinery.
prove a complete five-anchor refresh before broad wiring. splitting anchors
alone neither proves bounded work nor preserves snapshot semantics automatically.

existing targets are requirements, not observed passes: 500 ms maximum background
lock occupancy including retirement; cancelled backends retired within 500 ms;
unchanged foreground deadlines and visible-result targets. each due feed must
publish the settled revision within the defined 60-second quiet interval. use the
full existing plan's workload, clock boundaries and quality oracle; do not weaken
them or claim a percentile from a few successful cases.

the strongest objection to the proposed adapter is repeated work: up to five
anchors times two families means ten common-neighbor calls. each nonempty call
currently performs three database statements (bounded count plus exact id/read
or probe setting/ann read), before shared eligibility, anchor and graph ranking
costs. the proposed 400 ms computation allowance leaves less than 40 ms per
pair after shared costs. this is budget arithmetic, not measured latency or
proof of impossibility. the 25,000-vector exact threshold and 40 probes are
starting parameters, not a validated suggestion budget.

ann filters can underfill even when eligible neighbors exist. inspect exact
eligibility before selection and retain the plan's reviewed approximate recall
bound. the adapter must expand selected chunks into all authorized reading
identities, then apply its reading/chunk occurrence cap and grouping; a unique
chunk limit is not automatically the old per-reading occurrence limit. include
shared source/piece and x-capture occurrences in that proof.

## smallest decisive experiment

before wide pool/async rewiring, use one admitted native restored database and
one coherent repeatable-read snapshot per comparison:

1. capture current-source exact ordered output for fixed revision, ranking time,
   original anchor ordinals/vectors, eligibility and model. include a semantic-
   dominant nonempty five-anchor case, both families, restrictive pieces,
   repeated capture occurrences and a genuine empty case.
2. compare the predicate-only change for exact equality and current query plans.
   distinguish readiness/eligibility, neighbor selection, occurrence expansion
   and final ranking costs; use private fingerprints rather than query text in logs.
3. if the smaller repair cannot meet the contract, prototype the common-neighbor
   adapter in disposable investigation code. measure the complete refresh and
   backend retirement, not the best one neighbor query; compare first-page
   quality and every changed ref. include cold/warmed runs under the fixed limit.
4. only a candidate meeting both quality and occupancy proceeds to integration
   with pr 2 and contention/cancellation/quiet-window liveness qualification.

no query prototype or restored experiment was executed in this source-review
pass. native runtime, current migrated corpus and reference output are required.
the current-corpus experiment depends on pr 1's conversion being resolved;
historical 0317 replay alone cannot qualify the newer capture/reading semantics.
if the whole computation intrinsically exceeds its budget, retrying it every
five seconds cannot produce progress. revise the query within the accepted
contract or surface a concrete contract change for review; do not stitch partial
snapshots, increase limits or call perpetual rescheduling successful isolation.

## acceptance, costs and dependencies

on native restored data, compare exact predicate results, then explicitly measure
the permitted approximate candidate change. include semantic-dependent results,
both families, restricted pieces and an empty case. qualify foreground search,
contention, cancellation, lost claims, existing publications and eventual new
publication together with pr 2's warmed capacity workload. all migrated gate
callers must complete useful work; perpetual rescheduling is failure.

costs: bounded retries and stale suggestions during sustained contention. if the
approximate adapter is required, add its bounded recall loss and possible family
underfill explicitly. no new queue service, larger
limits, longer foreground waits, partial-ranking store or exhaustive fallback.
use [verification rules](local-rules/testing-standards.md); proof belongs in the pr.

issue owner: [observed contention](issues/production-search-admission-contention.md).
paired work: [database capacity](database-capacity-spec.md).

primary mechanism reference:
[pgvector filtering and probe/recall trade-offs](https://github.com/pgvector/pgvector#filtering).
