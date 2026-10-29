# actual 2 gib qualification remains open

status: open; a docker component on a larger host is a different proof.

the native host has roughly 7.57 gib memory. its passed transient-parent primitive
proved rootless cgroup placement, limits and owned cleanup, not whole-host fit.
the later 1280 mib component budget subtracts 128 mib host reserve, 128 mib for omitted
cloudflared and a declared 512 mib outside os/daemon/cache allowance from 2 gib.
that allowance is not a measured system bound. hosted web, auth, r2 and providers
are outside this server component.

fresh postgres was restored inside its final 512 mib/no-swap leaf and parent;
restore/analyze warmed its data/cache. fresh application processes are not an
os/database-cache-cold proof. retained-account/shared-image cache charges can
also predate the measured parent. the 7173 e8 run completed the functional flow,
including writing and settled feed convergence, but backup creation rejected its
invalid filename and the overall verdict stayed FAILED. the next 1b run used a
valid backup key and recorded oom 1/kill 1 in the 1280 mib parent; a strict job settled
DEAD attempt 1 with `E_RESOURCE_LIMIT`. backup naturally completed full verification
and maintenance exited 0. that does not repair the failed memory overlap or prove
actual 2 gib fit. [the overlap issue](search-backup-overlap-oom.md) retains attribution
and confirmed cleanup. current ff83/0329 canonical/semantic lab composition
passed with fake providers; full native runtime remains unqualified.

resolve the [capacity gate](production-database-connection-budgets-implicit.md)
on the actual 2 gib topology with all included leaves/reserves, cold and warm work,
both worker lanes, writing, maintenance/autoanalyze and verified online-backup
overlap. keep the existing private codex account/run volumes and existing release
transport ownership. no new full backup is a prerequisite to a bounded disposable
fixture mutation. historical environment/primitive/fixture receipts remain in the
privately archived original of this issue under
`.nexus-local/search-integration-docs-20261029.private/original-source/docs/issues/`.
