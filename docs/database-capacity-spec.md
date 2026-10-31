# database capacity

this specification owns physical connection topology, lifetime and memory
accounting. [search reliability](search-reliability-spec.md) owns the common
behavior, resource envelope, quality/progress acceptance and release gates;
[suggestion admission](suggestion-admission-spec.md) owns retrieval and publication.
these are responsibilities within one integrated repair, not prescribed pr splits.

## outcome and evidence

ordinary reading, durable writing, search, worker control and maintenance must
make useful progress inside the existing 2 gib ram host and postgres 512 mib/no-swap leaf
envelope, with the reserves defined by the reliability contract. zero oom alone
is insufficient: retain cold/warmed measurements, useful completion and cleanup.
normal services must fit while present, including idle workers and their retained
connections. heavy search, suggestions, indexing and backup may queue and
serialize at their existing owners. backup-window enforcement is not required for
this prototype under the [owner's decision](search-reliability-spec.md#decision).
finite queued work must resume and drain while reading, local writing and
cancellation remain usable. simultaneous heavy peaks are not an acceptance gate.
production enables at least 1 gib host swap; service leaves retain
`memswap_limit == mem_limit`. qualification records host ram headroom and swap
use/pressure without treating swap capacity as ram reserve. it neither requires
a swapless host nor zero host swap activity. an outer no-swap experiment cgroup
constraining an emulator's backing memory is an experiment detail, not a stricter
product requirement.

production and restored profiling support retained per-backend memory demand.
the earlier ten-retained/twenty-overflow sync pools and separate async/listener
connections had no aggregate bound. a few warmed backends completing selected
searches did not establish a safe allocation. exact allocator attribution remains
open in [the incident](issues/production-search-postgres-oom.md).

the current candidate implements finite role pools, zero overflow, separate short
control transactions, loop-scoped async engines and one shared api listener.
these are selected mechanisms for bounded ownership and control isolation, not
requirements to build a pool matrix for its own sake. their configured quotas
now have the bounded actual 2 gib evidence in [release acceptance](issues/release-search.md).
earlier native component publication/coexistence and later failed
backup-overlap memory work retain their recorded source and verdicts under
[the common evidence record](search-reliability-spec.md#evidence-and-uncertainty).
those earlier components alone did not qualify integrated schema 0329 or actual
2 gib fit; the later accepted evidence is distinct and retains its explicit limits.

## ownership and reachable topology

deployment composition owns the aggregate envelope; `db/engine.py` owns physical
checkout, `db/session.py` transaction adapters and `db/listen.py` notification
connections. entrypoints own process roles and event-loop lifetimes.

| owner | reachable demand to account for |
| --- | --- |
| api | ordinary sync/async work, search holders and physical waiters, control reads and one notification backend; one uvicorn process |
| interactive worker | one in-process handler, tools/provider orchestration, event-frame writes and independent heartbeat/claim/stop checks; its event loop ends only after owned work joins |
| background supervisor | one child plus parent heartbeat, claim, hooks and settlement; classify substantial hooks as ordinary work |
| background child | fresh process with its own engines and pools, concurrent with the supervisor and interactive lane |
| stream hints | the shared api notification connection plus ordinary authoritative rereads; subscriber count is not backend count |
| worker idle wait | ordinary pooled `LISTEN nexus_background_jobs`; counted in that pool, not concurrently with the same worker's handler |
| readiness | short control work under its existing 1.9-second logical deadline; joined startup/session cleanup may outlast the nominal two-second allowance, including overlapping probes |
| maintenance/operators | real backup, physical maintenance/autoanalyze, migration and cli/oracle work; identify which coexist and which stop runtime writers |

count the maximum reachable coexistence, not the sum of mutually exclusive peaks.
an exclusion counts only when the admission or operator owner enforces it; quiet
workload choreography alone does not exclude reachable demand. idle workers and
retained backends still count during serialized work and backup windows.
the prototype accepts the measured backup scope without claiming enforced
exclusion or proof of unrestricted overlap; this is a release-scope decision,
not additional memory evidence.
search serialization does not remove memory held by physical waiting backends.
postgres utilities and raw connections outside application engines need explicit
headroom. a container ceiling or `work_mem` sum does not prove resident headroom.

## physical and transaction contracts

- every connection creator has a finite counted allowance. overflow is zero;
  disabled capabilities fail before pool creation, never through sqlalchemy's
  unlimited `pool_size=0`. no raw fallback bypasses exhaustion.
- preserve capacity for heartbeat renewal, cancellation/claim checks and readiness
  while ordinary work is saturated. reserved pools are justified by that progress
  obligation and the demonstrated topology; count their retained memory too.
  ordinary generation/tool work never becomes control work merely to avoid waiting.
- bound physical checkout, not an entire logical session. release ordinary
  transactions before awaiting providers, nested search or worker completion.
  async pool waits must not block the event loop.
- keep each pool on its owning loop. join tasks and in-flight session work, close
  sessions, then await disposal before loop close. disposal alone does not close
  checked-out connections. search retains its physical lease until confirmed
  backend retirement, including fail-closed handling of uncertain cleanup.
- retain stream subscribe-before-read, initial/idle wakes, reconnect registration,
  authoritative rereads and idempotent close. notifications are hints; reconnect
  does not restore truth without a read. listener consolidation cannot silently
  reduce usable stream capacity.
- ordinary/control exhaustion reports `E_DATABASE_BUSY` through the existing
  transport owner. a write may already have committed: preserve its sealed
  identity, uncertainty and domain retry rule. local authored changes stay durable
  and retry their original sequence/bytes; there is no old online-first writer.

the candidate's source-owned `ConnectionCapacity` table gives each process finite
ordinary, search and control capabilities. entrypoints bind a role before engine
creation; background children bind their own role. no environment matrix or
duplicated deployment defaults is required. the table is a candidate allocation,
not proof that every pool should be warmed simultaneously or that its values fit.

ordinary checkout currently waits up to 5 seconds, control checkout independently
up to 250 milliseconds; readiness starts cancellation at its existing 1.9-second
work deadline. browser search refuses occupied capacity before embedding;
current client intent owns pending deferral and retry outside execution time.
[deployed capacity limits](issues/production-database-connection-budgets-implicit.md)
retain the accepted ordinary-use scope and unquantified combined headroom;
functional release acceptance does not establish unrestricted overlap reserve.
these are operational watchdogs, not product latency acceptance or permission to exceed a
caller/hosting ceiling.
engine-owned native setup separately uses a two-second connect timeout per
resolved address, the locked driver's minimum, for the single local postgres
endpoint. it does not time DNS resolution or make total checkout two seconds;
queue wait, address attempts and SQL have distinct costs. control SQL remains
bounded at one second. async callers retain their original logical deadlines;
these do not bound cleanup completion or response time. the engine's async creator
joins native startup without cancelling it and closes any returned connection
before releasing the pool slot, including under repeated caller cancellation.
readiness's nominal two-second allowance is not a physical retirement bound.
the targeted async startup-retirement defect is resolved at `4ceb03555`; this
does not qualify aggregate capacity or release behavior. outer cancellation alone
never proves native resource closure.

authored scope-input and scope-text preparation share one api-process permit
before session checkout, held through inline rollback/close. this bulk family
can occupy only one of the api's two ordinary sync slots. the other slot has no
exclusive chat priority and can be used by other ordinary work. contention may
return busy; the existing authored sync owner preserves staging and retries.
this corrects demonstrated bulk monopolization without increasing quotas.

## qualification and costs

inventory actual connection creators, process counts, listeners and external
utilities before freezing numeric quotas. use the canonical deployment and
existing disposable/native owners; no pooler, larger machine or new capacity
framework. compare query/private retained demand and physical connection census
under cold then warmed native workload. distinguish emulation and larger-host
components from the required actual topology.

record fresh application-process startup/first use separately from warmed
resident demand. neither establishes an empty operating-system or postgres
cache: restore/analyze and prior reads can warm the retained corpus. the selected
release carries those observed scopes and checks ordinary first use after
activation; it makes no cache-cold guarantee and selects no cache-flushing run.

qualify admitted readers/listeners, two clients, both worker lanes, writing,
generation stop, import/discovery/publication, reachable physical maintenance and
verified backup under the chosen serialization policy. backup need not overlap
heavy work; preserve headroom for maintenance/autoanalyze that can still coexist.
preserve the database and host reserves, complete and drain the finite workload,
and observe oom/recovery/restart/lost-claim deltas and physical retirement. operational
watchdogs and a diagnostic observation window are declared before execution;
expiry is noncompletion, not a passing memory or progress result. the
[common acceptance table](search-reliability-spec.md#meaningful-acceptance-and-release-gates)
remains authoritative; old subsecond/quiet-period targets are retired, with no
replacement numeric latency acceptance deadline.

costs include lower concurrency, bounded waiting, retained control/async backend
memory and async/listener ownership. require evidence for each extra retained
connection or lifecycle mechanism; prefer the smallest complete composition.
if it cannot preserve both headroom and useful progress, return that concrete
conflict for an owner decision instead of raising limits or hiding failure.

the current full corpus depends on the integrated migration/value-preservation
route. historical 0317 profiling and selected 0321 component receipts cannot
qualify the current 0329-after-0328 lineage. freeze and review the final reachable
allocation only after its native proof.

issue owners: [connection budget](issues/production-database-connection-budgets-implicit.md),
[production oom](issues/production-search-postgres-oom.md).
verification uses [the sole static gate and canonical manual workflow](local-rules/testing-standards.md).
mechanism references: [sqlalchemy loop ownership](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-multiple-asyncio-event-loops),
[postgres memory accounting](https://www.postgresql.org/docs/15/runtime-config-resource.html).
