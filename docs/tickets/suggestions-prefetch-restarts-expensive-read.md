# suggestions prefetch starts work its deadline cannot accommodate

status: open (two attempts source-confirmed; database overlap unmeasured)
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

prerequisite: decide the suggestions serving contract. seed a bounded,
published read model if adopted; otherwise stop launching the expensive
ranker as a speculative seed. do not lengthen shell blocking to fit ranking.

acceptance: one lectern entry has a documented request trace, bounded first
paint and no discarded full recomputation followed by a duplicate. verify
database lifetime separately from transport abort. no implementation here.
