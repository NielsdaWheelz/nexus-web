# production database connection budgets are implicit

status: open; separate from the measured jit memory repair
origin: 2026-10-14 release memory investigation, source58c7ecae6
area: deployment / database admission

production has no explicit role pool overrides. `config.py:95–98` permits
10 retained plus20 overflow connections per synchronous engine. api,
interactive worker, background supervisor and background child have separate
engines. raw sse listeners (`db/listen.py`, cap64) and async tool sessions
(`db/async_session.py`, nullpool) bypass those pool limits; readiness also
connects directly. postgres permits100 clients under a512mib cgroup.

the incident census observed16 idle client backends, including4 listeners;
listener logs reached8. these are connection counts, not proof of concurrent
queries. the two live memory kills and retained-backend replay show why
aggregate private memory matters. disabling jit reduces measured memory;
it does not establish a hard connection budget.

define the production admission budget at runtime composition, counting all
physical connection owners. preserve interactive lease renewal, streaming
writes and stop polling. a smaller synchronous pool alone is incomplete and
can convert memory pressure into pool waits or missed worker leases.

acceptance: explicit role/listener/async/probe budgets fit the fixed database
memory limit; representative concurrent reads and writes complete within
their deadlines, worker leases progress, and no postgres recovery/oom occurs.
keep the existing release workload qualification distinct from a maximum-load
claim. private evidence: campaign `attempts/58c7ecae6/postgres-memory-diagnosis/`
and `capacity-2g-reaudit-20261014/`.
