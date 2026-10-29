# actual 2 gib qualification remains open

status: open; a docker component on a larger host is a different proof.

the native host has roughly 7.57 gib memory. its passed transient-parent primitive
proved rootless cgroup placement, limits and owned cleanup, not whole-host fit.
the historical 1280 mib component budget subtracts 128 mib host reserve, 128 mib for omitted
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

the approved bounded guest experiment counts actual guest os, daemon and service
demand plus host swap use. it reserves the connector's unchanged full 128 mib cap
and the unchanged 128 mib host reserve: at least 256 mib combined host ram
headroom throughout, with postgres's 64 mib reserve independent. it uses no
declared 512 mib outside allowance or artificial memory load. a pass would prove
backend/os fit with the full connector cap reserved. connector transport is
UNRUN; the literal all-production/live-connector release gate stays OPEN.

resolve the [capacity gate](production-database-connection-budgets-implicit.md)
on the actual 2 gib topology with all included leaves/reserves, cold and warm work,
both worker lanes, writing, maintenance/autoanalyze and verified online-backup
overlap. production has 2 gib ram and at least 1 gib enabled host swap; postgres
and other service leaves retain `memswap_limit == mem_limit`. measure host ram
headroom and swap use/pressure, without crediting swap as ram reserve or requiring
a swapless host. any outer no-swap cgroup for an emulator's backing memory is
only an experiment constraint. keep the existing private codex account/run volumes and existing release
transport ownership. no new full backup is a prerequisite to a bounded disposable
fixture mutation. historical environment/primitive/fixture receipts remain in the
privately archived original of this issue under
`.nexus-local/search-integration-docs-20261029.private/original-source/docs/issues/`.
