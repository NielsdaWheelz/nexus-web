# recent nexus history loads every usage row

- status: open
- origin: 2026-09-13 second-tab investigation; revision `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: nexus history api memory and query work

## evidence

`python/nexus/services/nexus_history.py:41-66` loads and materializes every usage
row for the viewer, then keeps only five distinct recent targets in python.
the selected rows include visit timestamps and other fields unused by recency.
deployed revision `7e8fd48244b3b436965037738e05785bb4931be1` has the same code.
the initial history read therefore grows with lifetime usage despite its
five-result output bound. this is a static scaling hazard, not measured incident
causality.

## prerequisites and fix

retain the current definition of recency and tie-breaking; inspect the actual
history size and query plan. select the latest row per target and the five newest
targets in sql, project only the recency fields, and choose indexes from the
measured plan. preserve independent frecency semantics.

## acceptance

through `./scripts/test`, compare returned recency against an independent
ordering oracle over repeated targets and tied timestamps; establish that the
application materializes only the bounded recency result for a large history.
capture the current implementation failing that budget before accepting the fix.

## 2026-09-14 adversarial review — half met

the projection half is done: the `DISTINCT ON` subquery in
`python/nexus/services/nexus_history.py` now projects only the recency fields
(`target_href`, `label_snapshot`, `source`, `last_used_at`, `id`) instead of the
whole `NexusUsage` entity, so `visit_timestamps` JSONB, `use_count` and the audit
timestamps no longer cross the wire per distinct target.

the index half is **not** done, and this ticket's acceptance explicitly demands
it ("choose indexes from the measured plan"). the measured plan is already
recorded against it: run `66a2d2004332e575` returns only 195 driver rows at
100,000 retained rows but still **sorts all history, spills 10,392 KiB and takes
601.714 ms**, while frecency uses the existing index in 2.779 ms. adding a
supporting index unmeasured would violate `docs/rules/cleanliness.md`; the
remaining work is to capture `EXPLAIN (ANALYZE, BUFFERS)` for the recency query
against that large history and add the index the plan actually justifies, in the
same change as the plan receipt.
