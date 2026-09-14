# the native table characterization workloads still have no capacity owner

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native table metadata / capacity qualification

## what is wrong

`OfflineReadingTableHeadersTest` no longer spends blocking-lane time on sizes
nothing bounds: its characterize case reads
`System.getProperty("nexus.capacity.offlineReadingTableHeaders")` and, unselected,
runs one bounded size (256) instead of up to 262,144 cells / 8,000 overlapping
rows, while keeping every semantic assertion (selected source order, window
column, returned count, scratch deletion). the printed record carries
`selected_capacity_workload` so a bounded run cannot be mistaken for the measured
one. no latency or byte budget was invented, because §7 requires a qualified
percentile and a regression policy first.

three things remain, all outside that change:

- `OfflineReadingTableGeometryTest` still runs its unbounded characterization in
  the blocking lane.
- there is no capacity capability entry that selects either measured workload, so
  the measured numbers can only be produced by hand.
- `testdata/proofs.json` registers both modules under
  `citation-provenance-identity` while pointing at
  `apps/android/app/src/main/java/.../OfflineReadingTableGeometry.kt` and
  `OfflineReadingTableHeaders.kt`, which no longer exist — both moved to
  `app/src/test/java/...`. they are test-source qualification harnesses, not
  product owners, so the registration should be dropped rather than repointed
  until the sparse index is wired into the package owner.

## prerequisites

the capacity lane must be able to select a JVM characterization workload.

## proposed fix

give the geometry test the same property gate, add the capacity capability entry
that selects both, and drop the stale `citation-provenance-identity` registration.

## acceptance

no unbounded characterization runs in the blocking lane; the measured workloads
are selectable by one capacity invocation; the policy scan reports no
`proof-source-owner` violation for those two globs.
