# search reliability

prior implementation proposal, 2026-10-26, published as a supporting reference at
the owner's request. its behavioral budgets remain binding; the newer database
capacity and suggestion admission specs supersede its prescriptive mechanisms.
implementation, production activation and proof are separate stages. lasting contracts belong in module docs; proof belongs in the pr.

2026-10-28 planning refinement: the owner reiterated single-user simplicity.
the accepted resource, latency, recall and progress budgets below remain. treat
the detailed pool/lifecycle/listener and retrieval mechanisms as proposals to
justify through the smallest decisive experiment, not an implementation checklist.
current investigation and the two-pr boundary live in
[database capacity](database-capacity-spec.md) and
[suggestion admission](suggestion-admission-spec.md). they identify obsolete
online-first call sites and smaller candidates to measure first. reconcile the
chosen mechanism here before implementation; do not silently relax a budget.

## decisions and scope

repair database capacity, expensive-search admission and suggestion retrieval.
keep the current 2 gib host, postgres 512 mib/no-swap limit and existing service
limits. qualify desktop and phone with ordinary panes, imports and generation.
a brief announced release interruption is accepted.

permissions, publication identity, reading boundaries, model identity and committed
writes remain exact. semantic suggestion candidate recall becomes approximate;
retain at least 9 of the previous top 10 suggestions on each representative case
and review every added/removed item. compare canonical refs at the same corpus,
input revision, anchors, eligibility, calibrated model and ranking instant:
`overlap >= ceil(0.9 * min(10, old_count))`. freeze a semantic-dominant case with
at least two similarity-dependent first-page refs, both families, restrictive
pieces and a genuine empty case; a broken semantic lane must not pass on graph hits.

keep the existing 15-minute freshness policy and 30-second build spacing.
suggestions may remain stale during sustained competing work. each due test feed
must publish the settled input revision within 60 seconds of a recorded `t0`:
other admitted jobs have drained and foreground mutations have stopped. keep its
observer active. pre-existing suspended failures are identified at scenario start;
the test cannot exempt failures it creates. record full due-to-publication time
separately, including preceding imports; no promise bounds arbitrary import length.

non-goals: a larger machine, new search/queue service, external pooler, new ranking
explanations, new user controls, offline storage, generic scheduler, exported
snapshots, persistent partial rankings, a second lab runtime or wholesale lexical
rewrite. preserve the quiet-publication contract in
[suggestions module contract](modules/suggestions.md).

## target capability

| boundary | required behavior |
| --- | --- |
| foreground search | preserve direct/lexical/hybrid phases and useful earlier results; `keats` and `tolkien` succeed under the qualified mixed load |
| deadlines | retain api 400/1500/5000 ms and browser/bff 1000/2250/5750 ms; no timer restart at internal boundaries |
| visible results | retain warm direct/text/related targets 500/2000/4000 ms; a small mandatory case set proves those cases, not a percentile |
| background occupancy | at most 500 ms uninterrupted expensive-lock ownership, acquisition through confirmed backend retirement, in every qualified case |
| cancellation | cancelled/waiting search backends disappear within 500 ms of cancellation; never release admission ahead of backend cleanup |
| capacity | every physical connection has a finite process allowance; aggregate warm demand fits the unchanged host/database limits with measured headroom; zero oom kills or database recovery |
| progress | reading, acknowledged writes, worker heartbeats, generation stop, import completion and a real new suggestion publication all remain possible |

these are acceptance requirements, not claims about current performance. failure
blocks release; it does not permit larger limits, silent recall loss, longer
foreground waits or permanent background deferral.

## database ownership

`db/engine.py` owns physical checkout. `db/session.py` owns transactions and
session adapters. deployment composition owns the sum across every process,
including the background supervisor and its child. ordinary, search and control
allowances are separate; all pool overflow is zero. readiness probes use bounded
control checkout. include listeners, migrations and operator headroom explicitly.

retain ordinary `get_session_factory()` and `open_async_session()`. add
`get_control_session_factory()` and `open_control_async_session()` for heartbeat,
stop/claim checks and readiness; search admission alone uses its dedicated pool. bound
physical checkout, not the lifetime of an `AsyncSession`: a session can release
its transaction and then invoke nested search. do not hold ordinary/control
transactions while waiting for search, providers or worker completion.
control sync/async sessions have separate caps and short statement deadlines;
preserve readiness's existing two-second aggregate bound. control work never
inherits the worker's 300-second query allowance or runs substantial domain work.

use sqlalchemy's finite pools. one active `async_database_scope()` per process is
owned by the api lifespan or a sequential worker attempt. create its engines
lazily and require the owning event loop. join owned tasks, close their sessions,
then await engine disposal before loop close and clear the scope; disposal alone
does not close checked-out connections. search checkouts are physically invalidated
on exit. no cross-loop cached pool, implicit engine creation outside a scope or
session-wide semaphore.

`db/listen.py` owns one raw autocommit connection per api process and fans out
existing `(channel, key)` subscriptions. register the stream owner's finite channel
set (`nexus_writing`, `nexus_suggestions`, `chat_run_events`, `oracle_readings`,
`media_events`) and await every `LISTEN` acknowledgement before the sole notification
consumer starts. later subscriptions are local; reconnect repeats registration.
retain the public listener API and 64-subscriber cap; coalesce pending wakes per
subscriber. subscribe before initial
read; preserve initial and idle wakes, committed-state rereads and idempotent
close. connection failure wakes/terminates all affected subscribers; existing
stream retry reconnects and rereads. notifications remain hints, never state.

one source-owned typed table in `config.py` declares `ConnectionCapacity` for
`api | interactive_worker | background_supervisor | background_child | maintenance`.
its fields are `ordinary_sync`, `ordinary_async`, `search_async`, `control_sync`,
`control_async`: finite nonnegative integers; zero disables a capability before
pool construction, never sqlalchemy's unlimited `pool_size=0`. entrypoints bind
their role before engine creation; children explicitly select their own role.
retain one finite ordinary checkout wait; search uses its absolute async deadline.
remove superseded pool-size/overflow settings and unbounded async/raw-readiness paths.

before green, freeze numeric table entries from native warm-load measurements and
validate the sum for the highest simultaneous topology, listener and external
probe/backup/operator headroom against the connection ceiling. maintenance callers
use their bounded role; alembic and existing postgres utilities stay independent
and counted. no environment matrix or duplicated deployment defaults.
record allowances, peaks, warm baseline and remaining memory headroom in the pr.
freeze the required memory reserve before green; include retained backends,
concurrent query peaks, maintenance and host demand, not just zero oom events.
capacity tuning changes this table and takes a normal artifact release.

trade-offs: lower concurrency, bounded waiting, extra async lifetime ownership and
listener fanout; retained async backends cost memory. these costs must fit the
same measurement. no separate distributed admission controller is required.

## retrieval

first change the positive readiness comparisons owned by
`content_indexing.reading_chunks_sql` and the suggestion vector joins to
`(lexical_revision = revision) IS TRUE`. reuse migration 0317's statistic and the
form already used in `search/semantic.py`. replay the captured exact query and
compare ordered results before replacing its executor. do not add an index by
guesswork or cap lexical occurrences before owner grouping.

keep the common `nearest_chunks(db, embedding, *, owner, params, limit, ctes)`
interface and its caller-owned snapshot. `suggestions._similar` adapts it:

1. capture each original anchor ordinal, first eligible stored chunk and original
   vector under the existing calibrated provider/model/dimension.
2. query separately per anchor and eligible `GraphThread`/`Rediscovery` family,
   with `limit=400`; destination eligibility, self-exclusion and canonical
   reading-chunk membership are inside candidate selection.
3. project candidate chunks to every eligible reading identity, including bounded
   pieces. rescore against the original stored vector, enforce the existing 0.80
   threshold, order by distance/media-id/chunk-id and take at most 400 reading/chunk
   rows per anchor/family before grouping by media.
4. preserve original anchor attribution, evidence precedence, family rotation,
   diversity and the existing bounded publication of canonical refs.

candidate membership alone is approximate; families may underfill. deterministic
tie ordering applies within the retained set, not equal-distance ann cutoff
membership. no exhaustive fallback. the common reader's cardinality routing remains
one mechanism, not parallel old/new executors. its current threshold and probes
are starting settings, not proof of bounded cost; any tuning must requalify both
browser retrieval and suggestions. delete `_media_neighbor_rows_sql` and its
exhaustive cross-product path after green.

## admission and publication

one native async gate owns every expensive search:
`search_session_async(*, deadline: float, purpose: Literal["foreground", "background"])`.
the absolute deadline includes checkout and admission; test an already-short
remainder, not only full budgets. allocate bounded search checkout before the
database-wide session advisory lock. foreground waits within its remaining
deadline; background uses nonblocking admission and yields to contention.

remove synchronous `search_session`. its four callers move at existing async
boundaries: shortlist job; connection discovery's `_scan` through
`search_scopes_async` (delete redundant sync `service.search`); oracle `_prepare`
through its existing async `_run`; picker route made async using shared http
cancellation ownership. oracle retrieval and picker semantic search use five-second
deadlines; strict tools retain their caller's deadline. retain sync SQL helpers via
`AsyncSession.run_sync`. use existing `embed_texts_async` for shared embedding;
remove thread-wrapped embedding. providers remain outside search admission.
already-async callers await directly; only sync job entrypoints use `asyncio.run`
and own a database scope. preserve each caller's existing embedding-failure contract.

the synchronous suggestion handler runs its read phase in one `asyncio.run` scope,
using the loop-owned database scope, `search_session_async` and
`AsyncSession.run_sync`. one read-only repeatable-read snapshot owns revision,
ranking time, anchors, eligibility and the complete result. provider calls never
run under this lock. apply the remaining database statement timeout after the
admission transaction rolls back; cancel and join on deadline or retirement.

reserve cleanup inside the 500 ms occupancy requirement: initially target at most
400 ms admitted computation and 100 ms retirement, then qualify the actual total.
always join cleanup even if it overruns; never manufacture a successful bound by
unlocking early or abandoning the backend. five short queries do not prove a
short complete refresh.

background admission refusal or expiry of this operation's owned computation
budget retires the backend, then returns existing `RescheduleRequested` for database
time +5 seconds, refunding the attempt with unchanged job/payload. only the owned
deadline and its identified statement-timeout backstop qualify; arbitrary timeout,
shutdown, lost claim and database/invariant errors retain their existing handling.
real failures retain bounded attempts and suspension. no partial or fabricated-empty
publication. this rule applies to every background gate caller.

trade-off: a costly query and transient pressure can both exhaust that budget.
log `admission_busy` versus `computation_budget`, including job age; a missed quiet
window is a liveness defect, not permission for permanent deferral. require useful
completion in qualification; add no idle detector, adaptive recall or deferral store.
after backend retirement, the existing short transaction rechecks authority and the execution
claim, publishes atomically and settles the job. preserve the prior publication
until that succeeds.

storage stays unchanged: feed/work identity, shortlist id, ranking timestamp,
input revision and canonical target refs. previous publications are compatible
data, not an old execution path. no migration, algorithm-version column, wire
bump or compatibility parser is needed for retrieval. stop old workers
at release; only the new executor produces subsequent publications.

## api and content design

the content designer owns the meaning of each feature's existing presentation:

| feature | good content and schema contract |
| --- | --- |
| search | truthful phase-specific progress, retained actionable results and scoped retry; “no results” only after successful completion. preserve 504 `E_SEARCH_TIMEOUT`, retired-request 499 and 503 `E_EMBEDDING_PROVIDER_UNAVAILABLE`; never conceal requested semantic failure as successful hybrid. preserve legitimate `semantic_status=not_requested` |
| capacity | add 503 `E_DATABASE_BUSY`: “nexus is busy. wait a moment, then retry.” a write may already have committed; retain its sealed intent and its owner's uncertainty/retry behavior. never claim nothing changed or discard writing |
| suggestions | publication id/items remain the interface; current eligibility and stable visit order are visible through correct rows. no invented reasons, confidence scores or exhaustive-recall claims. ordinary refresh reads latest; background 202 acknowledges admission, not a new ranking |
| operations | existing structured logs identify request or job/execution, process role, phase, backend pid, checkout/admission/hold/cleanup durations, deadline and outcome. distinguish cancellation requested from backend retired; record fingerprints, never private query text, vectors or credentials |

no new public routes or payload fields. ordinary/control checkout exhaustion maps
to the new 503 code at `api/edge.py`; search translates its expiry to 504 first.
after stream headers, terminate through the existing stream owner, not a second
json response. 409/429 are unsuitable for generic capacity failure because callers
treat modeled 4xx as definite write refusal.

add busy to shared `outcomeUnknown` and `apiTransportFeedback`; consolidate direct
transport whitelists onto those owners where semantics match. preserve each write
owner's existing bounded automatic/manual retry contract and request identity;
add no global replay. cover notes, bootstrap, connections, sharing and suggestion
admission confirmation. pair clients: this behavioral change rides current main's
already-bumped wire 17 after deployed 16; verify release identity before activation
and apply the once-per-release rule. the error envelope is not a generated closed
schema; run wire freshness checks and regenerate only if its actual input changes.

## exclusive work boundaries

abbreviated backend paths are under `python/nexus`; search, generation, oracle and
domain services are under its `services/`. abbreviated web paths are under
`apps/web/src`. the retained driver is `apps/web/scripts/lab/search.ts`.

| slice | owned files and responsibility | depends on |
| --- | --- | --- |
| a: database capacity | `python/nexus/db/{engine,session,listen}.py`, `config.py`, `app.py`, `api/routes/stream.py`, `runtime_health.py`, `apps/worker/main.py`, `jobs/{worker,process_executor}.py`, generation `{runtime,run,codex}.py`, `cli.py`, `oracle/corpus.py`; bounded owners/control wiring. retained lab driver's embedded python receives role/scope wiring only | native baseline |
| b: retrieval | `python/nexus/services/content_indexing.py`, `search/semantic.py`, `suggestions.py`; readiness, native embedding, candidate adapter, exhaustive executor deletion | exact reference; independent of a |
| c: admission and refresh | search `{admission,service,pickers,discovery,sources}.py`, `api/routes/{search,resource_items}.py`, new `api/search_operation.py` extracted from the existing route's cancel/join owner, `connection_discovery.py`, `oracle/readings.py`, `suggestion_shortlists.py`; gate callers, job async scopes, refusal/reschedule and publication. `sources.py` changes only for a measured strict-query defect | a's lifetime API; b's retrieval API |
| d: capacity response | `python/nexus/{errors.py,api/edge.py}`; web `lib/api/client.ts`, `lib/notes/writes.ts`, `lib/workspace/bootstrap.server.ts`, `lib/useSuggestions.ts`, `ConnectionsSurface.tsx`, `ShareOverlay.tsx`; uncertainty contract and content | a's exhaustion behavior |
| e: integration and release | `deploy/hetzner/docker-compose.yml`, `.env.example`, `deploy/env/env-prod-backend.example`, module docs, `docs/issues/release-search.md`; verify existing lab composition, temporary cases and release | a–d |

one owner edits each listed boundary. a and b may proceed independently after red;
c consumes their agreed interfaces. e integrates, does not duplicate their code.
inspect call sites before adding helpers; consolidate repeated connection creation
inside its existing owner. keep ranking policy out of database infrastructure.

## red green refactor and release

1. capture the deployed reference and exact nonempty suggestion oracle; inventory
   connection owners and native topology. adversarial review rejects missing
   ordinary/control/listener paths or benchmarks without semantic candidates.
2. write temporary cases through the existing disposable lab/browser helpers and
   recovery-profile workflow; browser cases live in ignored
   `apps/web/.nexus-lab/cases/`. induce failure only in isolated disposable systems,
   never by reproducing oom on production. observe the exact target failure before edits;
   setup/auth/provider failure is not the intended red. freeze cases and quality
   thresholds before tuning. before broad wiring, prove the proposed complete
   five-anchor refresh can meet the native occupancy and quality targets; otherwise
   revise the retrieval design within these constraints before expanding changes.
3. implement a–d, reach green, independently review resource lifecycle, retrieval
   correctness and content, then refactor at the owning modules. rerun affected
   cases and `./scripts/test`; never weaken an assertion to obtain green. run
   `./scripts/lab -- bun apps/web/scripts/lab/search.ts` for the three retained
   foundation checks; do not substitute its unresolved fake-provider variant.
   unchanged foundation checks need not be manufactured into red.
4. native restored profile: verified archive, pinned images, isolated disk-backed
   database, current schema and representative rows, using `deployment.md`'s
   recovery owner. use an existing native amd64 host with the production limits.
   mac emulation is diagnostic only. a 512 mib database on a larger machine proves
   only that database boundary. fresh browser labs own protocol/interaction checks;
   final native production qualification owns the full 2 gib host/two-client/worker
   boundary. do not restore over a running browser lab or add another runtime.
5. qualify desktop search/reader/lectern/library panes plus phone search/reader,
   their real reads/listeners, and both worker lanes. replay `keats`, `tolkien`,
   prefixes, supersession and disconnects with cold then warmed connections.
   measure memory, connections, actual lock release and useful progress together.
   freeze a finite workload; imports/generation must finish, not merely stop being
   observed. record counter deltas for oom/oom-kill, recovery, restarts and lost
   claims, plus maximum hold/cleanup, connections and peak/warmed memory.
6. verify exact scope/piece/model/threshold/anchor/tie behavior, reviewed first-page
   recall, withdrawal during refresh, lost claim, contention without spent attempts,
   listener loss/reconnect, ordinary writes and generation stop during saturation.
   prove every due feed's new-revision publication within the 60-second quiet
   interval. saturate ordinary checkout before a write and after a prior commit:
   both preserve uncertainty and request identity; verify each owner's retry rule.
   require nonempty connection-discovery completion under the background budget,
   preserving its strict retrieval semantics; repair its `search/sources.py` plan
   only if measured necessary. exercise oracle/picker success, failure and retirement
   after their async conversion. no caller may reschedule forever unnoticed.
7. independent final review must approve design, green evidence and refactored
   ownership before the announced release. use the existing stopped-writer,
   backup and paired-release owner; verify native production/client behavior and
   artifact identity. retry only identified incident-suspended work through its
   existing repair owner after the cause is fixed. release-owner recovery remains
   schema-compatible; the known-broken predecessor is not incident resolution.
   record the concrete recovery sequence; never run mixed old/new workers.
8. after final qualification, delete temporary cases, fixtures and executable
   diagnostic drivers. preserve private outputs and the existing three retained
   search foundation checks. commit no corpus, evidence dump or new scenario suite.
   record net authored lines/deletions in the pr; close only proved issue records.

release evidence distinguishes static, disposable e2e, native restored and live
production results. unsupported native profiling or a missed budget is a named
blocker, not a waiver. exact allocator attribution may remain a separate issue
after the combined capacity and progress contract is proved.

## sources and tracked failures

- [production oom](issues/production-search-postgres-oom.md),
  [connection budgets](issues/production-database-connection-budgets-implicit.md),
  [admission contention](issues/production-search-admission-contention.md).
- [verification owner](local-rules/testing-standards.md),
  [current release contract](issues/release-search.md).
- [sqlalchemy loop ownership](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-multiple-asyncio-event-loops),
  [postgres memory accounting](https://www.postgresql.org/docs/15/runtime-config-resource.html),
  [pgvector filtering](https://github.com/pgvector/pgvector#filtering).
