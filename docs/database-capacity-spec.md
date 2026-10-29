# database capacity

investigated planning draft, 2026-10-28; pr 2 of the release repair scope.
published for review at the owner's request. specification only. the existing
[search reliability plan](search-reliability-spec.md#database-ownership) records
the accepted budgets and an earlier detailed implementation proposal. the owner's
latest clarification is to keep this a simple single-user application. preserve
those behavioral budgets; treat the proposed role table, extra pool families,
control apis, listener fanout and async scope as candidates requiring evidence,
not a checklist to implement. reconcile the settled mechanics into that plan
before implementation, including its obsolete local-first call sites.

source investigation at `96a3b7bdf` establishes the ownership and topology below.
numeric allocation and native mixed-workload capacity remain unqualified. this
pass ran no application, restored database or production workload.

## outcome and known evidence

ordinary reading, durable writes, search and workers must progress within the
existing 2 gib host and 512 mib/no-swap postgres envelope, with measured headroom.
current `config.py` allows ten retained plus twenty overflow connections per
synchronous engine. `db/engine.py` uses an unpooled async engine; `db/listen.py`
admits up to 64 raw connections per process. workers, children and probes add
physical connections outside any one pool's budget.

retained-backend profiling reproduced exhaustion on the restored production
corpus. four warmed backends passing selected searches does not establish a safe
allocation. those exact-image experiments ran amd64 under arm64 emulation;
native capacity and the allocator's full contribution remain unresolved.

## verified source inventory

| owner | actual connection/lifetime behavior | accounting obligation |
| --- | --- | --- |
| api | one uvicorn process in the image command; sync request sessions and native async search | bound total checkouts and prove readiness/cancellation progress |
| interactive worker | one job at a time in process; independent heartbeat thread; generation creates/closes an event loop per attempt | count handler/tool work concurrently with heartbeat, stop polling and claim checks |
| background supervisor | one child at a time; parent keeps heartbeat and settlement | count its connections alongside its child's; classify hooks by actual work |
| background child | fresh python process per job, importing its own engines | count its separate engine alongside its parent and the other lane |
| stream hints | one raw autocommit connection per current `Listener`; each wake opens an ordinary snapshot | include admitted listeners and ordinary rereads; consolidate only if required to fit the budget |
| worker idle wait | `_wait_for_work` uses `LISTEN nexus_background_jobs` on its ordinary pooled connection | count within the worker's pool; it does not run alongside that worker's handler |
| readiness | `runtime_health.is_database_ready` opens raw psycopg with a two-second aggregate contract | count overlapping probes and preserve their aggregate deadline |
| maintenance | nightly backup can overlap runtime; migration stops writers; cli/oracle seed can create application engines | count admitted application and postgres utility/operator work; no new maintenance framework |

evidence owners: [engine](../python/nexus/db/engine.py),
[worker loop](../python/nexus/jobs/worker.py),
[generation lifetime](../python/nexus/services/generation/runtime.py),
[stream routes](../python/nexus/api/routes/stream.py),
[readiness](../python/nexus/runtime_health.py).
the writing stream still exists; its payload is now an authored head/annotation
hint. the api's five channel names remain `nexus_writing`, `nexus_suggestions`,
`chat_run_events`, `oracle_readings` and `media_events`.

## owners, scope and invariants

- deployment composition owns the aggregate physical budget; `db/engine.py`
  owns checkout, `db/session.py` transaction adapters, and `db/listen.py` streams.
  entrypoints own engine/event-loop lifetime and their configured limits.
- count api, interactive worker, background supervisor/child, async sessions,
  listeners, readiness, backup/migration and operator headroom. enumerate which
  can coexist rather than summing mutually exclusive or historical peaks.
- establish finite physical allowances with zero pool overflow and truthful
  exhaustion. separate pools, a five-role table and one notification connection
  per api process are possible means, not the invariant. preserve existing
  stream subscribe-before-read, reconnect and authoritative rereads.
- preserve capacity for heartbeats, cancellation, claims and readiness during
  ordinary saturation. bound physical checkout, not entire logical sessions;
  avoid holding one scarce connection while awaiting nested acquisition.
- retain uncertain-write identity and each domain's retry contract on exhaustion.
  current local-first writing supersedes older web call sites named in the plan.

## boundary agreed with pr 3

pr 2 owns the total physical bound and ordinary-capacity error translation.
retain existing session functions and loop behavior where they satisfy the bound.
its interface promises finite admission, correct release and capacity for required
control work; it does not yet promise separate engines or new control-session
functions. choose those only when the smallest measured composition cannot
establish progress. never use sqlalchemy `pool_size=0` to mean disabled.

pr 3 owns operation deadlines, the session advisory lock, nonblocking background
admission, cancellation/retirement, ranking and rescheduling. checkout is counted
within pr 2's total bound and pr 3's original absolute deadline. only pr 3
may decide whether admission refusal becomes a foreground timeout or a background
reschedule. it cannot open a raw fallback connection.

minimal allocation wiring in `search/admission.py` belongs to pr 2; its policy
rewrite belongs to pr 3. existing synchronous search callers remain finitely
counted while pr 3 settles their deadline/cancellation paths. the intermediate
pr is not release-qualified.
develop pr 3 against this interface and qualify the merged cohort.

control progress means heartbeat renewal, stop/claim checks and readiness;
domain settlement hooks and publication need individual classification. no new
control-session API is required merely to name that distinction. `generation.run._watch` currently
performs synchronous checkout inside an async loop. its replacement must not
block the loop on a pool wait. ordinary `Runtime.session_factory` must not become
a control factory globally, since it also writes generation records.

the old plan names removed web files `lib/notes/writes.ts` and
`lib/workspace/bootstrap.server.ts`. map capacity response changes to the current
`lib/api/client.ts` and actual server-owned command consumers. authored
`lib/authored/worker.ts` rejects non-2xx status; `sync.ts` preserves pending bytes
and retries generic failures already. qualify that behavior with a real 503;
do not reconstruct the old online-first writer. ordinary server-owned writes
still need `E_DATABASE_BUSY` treated as uncertain, with their original identities.

## next specification work

inventory every connection creator and maximum process topology. map proposed
ordinary/control/search responsibilities to real callers. determine numeric
allowances, checkout behavior and memory reserve from native warmed measurements,
then freeze them before green. specify loop shutdown and checked-out connection
retirement, listener loss/reconnect, and the external utility allowance.

measure the smallest candidate first:

1. explicitly lower existing synchronous pool limits and set overflow to zero;
   preserve the current process topology and configuration owners. no new role
   abstraction is needed merely to give the existing processes different values.
2. bound asynchronous physical checkouts while retaining `NullPool` and the
   existing per-attempt loops if possible. first use actual operation ownership:
   `services/tools/run.py` already grants `max_in_flight=1`; the worker runs one
   job at a time. count claim checks and nested calls too. bound api async work
   before it opens connections. a gate over an entire logical session can
   deadlock nested search and is not an acceptable shortcut.
3. retain direct listener connections if their admitted count fits the measured
   envelope with ordinary rereads. if required stream concurrency does not fit,
   one shared api listener is justified; do not silently lower usable stream
   capacity to make the measurement pass.
4. prove control progress using the actual bounded workload. add a narrow
   reserved connection/pool only where starvation is demonstrated or follows
   from the topology. avoid a full ordinary/search/control pool matrix by default.

if retaining unpooled async connections needs more custom lifecycle machinery
than a finite loop-owned pool, choose the pool instead. the decision is about
total complexity and proof, not preserving `NullPool` as doctrine. pooled
connections must never cross loops. numeric caps remain open in either design.

no unmeasured pool number is selected here. do not add an external pooler or a
larger machine; session advisory locks/listeners require their existing session
identity. separate runtime privilege hardening remains its own follow-up.

the aggregate bound is the sum of each simultaneously live process's physical
allowances, admitted listeners and external utility/probe connections.
worker idle listeners are already charged to their pools. count search waiters
as physical backends; serialized query execution does not remove their memory.
verify warm private memory and query peaks in addition to that connection count.

the strongest objection to expanded pool separation is that it adds retained
backends while repairing retained-backend memory. lazy creation alone does not
solve this once every lane is warm. require measured evidence before adding
those pools or listener consolidation; neither is an automatic prerequisite.
do not infer a safe budget from the sum of container ceilings or `work_mem`.

smallest decisive experiment: on an admitted native amd64 restored corpus, replay
the recorded ordinary-read sequence with a controlled connection census, retain
the warmed connections, then add the representative foreground query and worker
control traffic. measure each increment and retirement, freeze candidate limits
and reserve, and only then expand to the mixed workload. use an isolated database
under the production cap; no live failure reproduction. retrieving the retained
query/evidence and preparing that native runtime remain prerequisites.
historical 0317 replay can refine the incident baseline independently. final
current-source proof needs pr 1's production-corpus conversion resolved; new
authored/capture queries cannot be qualified against an unmigrated schema.

## acceptance, costs and dependencies

use a native restored corpus and the fixed limits. qualify warmed desktop/phone
panes plus both worker lanes, search, imports and generation. measure physical
connections, warmed/peak memory, reserve, oom/recovery/restart deltas and useful
completion together. prove writes, lease renewal, stop and readiness still work
under saturation. disposable failures must not be induced on production.

costs: reduced concurrency and bounded waits. additional async lifetime ownership,
pool reserves or listener fanout carry costs only if the measured design needs
them; retained async backends themselves consume memory. pr 3 owns query work
and admission policy. agree checkout/lifetime interfaces before implementing it;
neither pr alone establishes the combined capacity/progress contract. use
[the sole static gate and canonical manual workflow](local-rules/testing-standards.md).

issue owners: [connection budget](issues/production-database-connection-budgets-implicit.md),
[production oom](issues/production-search-postgres-oom.md).
paired work: [suggestion admission](suggestion-admission-spec.md).

primary mechanism references:
[sqlalchemy event-loop ownership](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-multiple-asyncio-event-loops),
[postgres per-operation/per-session memory](https://www.postgresql.org/docs/15/runtime-config-resource.html).
