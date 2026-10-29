# suggestions prefetch starts work its deadline cannot accommodate

status: historical duplicate-attempt diagnosis; its exact database overlap remains
unmeasured. current suggestions use a completed published read model and a
separate observed refresh job, as owned by
[the suggestion contract](../modules/suggestions.md). the historical 500 ms seed
allowance below is not a current latency requirement.
origin: 2026-10-14 lectern latency diagnosis, source `367da80e0`
area: workspace / suggestions acquisition

`apps/web/src/lib/panes/paneResourceLoaders.ts:59-67` selects suggestions as
the lectern server seed. `lib/api/resourceTransport.ts:3-7` gives that read
500 ms. `lib/workspace/bootstrap.server.ts:66-81` drops a transport timeout;
the unseeded section then starts its ordinary browser read.

the retained jit-off restored-corpus receipt for image `665e7b3af` measured
the same suggestions owner at 6.882 seconds, versus 0.603 seconds for quick
reads. see `synapse-slate-query-plans-unmeasured.md` for evidence paths.
the seed therefore spends its budget on a recomputation it cannot deliver.
`api-sync-work-outlives-request-cancellation.md` establishes that synchronous
database work can outlive cancellation, but overlapping execution from this
specific seed/client pair has not been observed.

the serving decision is now made: ordinary reads/refresh never run ranking inline.
retain this historical failure; do not restore its removed online-first bootstrap
owner or duplicate recomputation merely to reproduce it.

resolve the remaining historical overlap question only with attributable evidence;
do not repeat runs to manufacture it. current qualification instead traces one
normal lectern visit through useful publication reads, with no discarded full
recomputation followed by a duplicate, and verifies database lifetime separately
from transport abort under the common reliability contract.
