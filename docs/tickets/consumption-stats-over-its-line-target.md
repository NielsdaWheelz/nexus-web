# remaining consumption stats contract follow-ups

status: open · origin: 2026-09-28 consumption-stats reauthoring; qualified 2026-10-03 session-page cut · area: consumption / stats

remaining evidence:

- `services/consumption/stats.py:35,39` accepts and labels `Week`, but the web
  `app/(authenticated)/stats/statsPeriod.ts:21` maps its week view to `Day`.
  the current whole-repo census finds no android, extension or node producer.
  assess this unproduced input separately; period math is not part of this cut.
- retain `totals.recordedActiveMs`: the pane reads it at `StatsPaneBody.tsx:903`
  for its empty state. `activeMs == 0 && activeExclusions.length == 0` is not
  proved equivalent: accepted sub-millisecond range edges can clip an excluded
  1 ms span to 0.4 ms. `services/consumption/stats.py:211` rounds the duration
  sum to bigint zero while `:316-331` retains the exclusion row. this is a
  source-qualified conservation counterexample, not a runtime reproduction or
  new product defect. any removal requires explicit precision policy or proof.
- local-midnight ownership remains in its existing
  [ticket](stats-local-midnight-rule-has-two-owners.md); skipped-date behavior is
  separately recorded in [ticket](stats-day-view-fails-on-a-zone-skipped-date.md).

historical line-count targets are not correctness requirements or a reason to
compress code or delete read fields. a line target establishes no requirement
for pane restructuring or totals-field deletion.

fix: select only evidenced unused behavior or duplicated ownership. preserve
recorded duration and empty-state semantics; establish precision requirements
before any totals projection change. resolve timezone work through its owners.

acceptance: a selected cut has a complete producer/consumer census, conserved
stats and session facts, range/scope/snapshot and issued cursors where affected,
independent meaningful proof and passing `./scripts/test`. line count alone
establishes nothing.
