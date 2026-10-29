# production search exhausts postgres memory

status: open; observed on production `3d81ef45ef28f637a4de07c66ab172bbab9e22c2`,
schema `0317`, on 2026-10-26.

kernel logs prove postgres cgroup kills at 18:11:49 and 18:16:12 utc under its
512-mib limit. postgres terminated its other backends and recovered each time;
the container restart count stayed zero. the api had zero oom, memory-limit or
restart events. the first kill had 434,728,960 bytes anonymous, 76,333,056 shared,
and 25,387,008 kernel memory; only 401,408 bytes of file memory were outside
shared memory. nonreclaimable demand exhausted the container's capacity.

two natural launcher bursts produced 35 api phase requests: 9 succeeded,
24 returned 504 and 2 returned 500. lexical request
`58bb9571-c9fd-4a5f-b8da-b5ebd5c9b25f` acquired admission in 11.61 ms, entered
indexed retrieval, fired its 1.5-second timer, and completed cleanup only after
the first kill, returning after 8.09 seconds. admission and embedding did not
cause that failure.

hybrid request `fc0a0337-31a0-4ffb-9957-dc1512177eb4` finished embedding in
405.67 ms and initial neighbours in 79.10 ms, then spent 4.65 seconds in indexed
retrieval until the second kill. victim postgres pid `87881` emitted a native
planner warning at 18:16:07.912 naming keyword eligibility relations
`cc, m, p, part, rai, s, state`. its failed statement retained only a 1023-byte
prefix. the warning identifies query-family involvement, not a faulty allocator.

responsible path: `search/discovery.py:475` -> `search/indexed.py:362,256` ->
`search/indexed.py:134-247`. eligibility, native matches and owner winners are
materialized before preview limits. ordinary pooled backends also retain
memory; `docs/issues/production-database-connection-budgets-implicit.md` remains
open. query peak versus retained backend memory is not yet attributed. neither
a leak nor a particular extension allocation is proved.

resolution: profile the exact deployed query on a restored corpus with normal
retained connections; attribute allocations, then verify typing, cancellation,
readers and background work within service/host memory budgets and deadlines
without database recovery. keep the separately observed
[suggestion lock starvation](production-search-admission-contention.md) distinct.

private raw evidence is retained in the temporary directory
`nexus-search-diagnosis-20261026-mrtsxuuo`. kernel sha256:
`640e2a15b8f15e306cfe752b6f3377c6cb7ddfc4c0609d65ea272b35ad5d07ad`;
postgres-2 sha256:
`7f1bcb28fb863f57dc8c6f136150b2d4bace99c42807875245d75e54b059e40e`.

2026-10-26 isolated profiling reproduced the capacity failure with the exact
deployed postgres/api image digests and verified nightly schema0317 archive
`2f7c4136c098aaab4d355b6564b070a9ff7a17f9a3ff3081a6af8e2bce066d78`.
the disk-backed clone was restarted at512mib/no swap after restoration. fresh
`keats` and `tolkien` indexed statements completed. ten retained connections,
warmed with the incident's ordinary media-summary/import-summary/lectern and
four document-map service reads, left310.84mib anonymous memory; `keats` pushed
that above424mib plus72mib shared memory and caused database recovery.

after explicit clone `ANALYZE`, four warmed connections completed both searches.
a subsequent control using ordinary SELECTs without EXPLAIN exhausted memory
during warming, before another search could run. repeating the read sequence
four times on one backend kept total anonymous memory around82.5–84.4mib;
closing it reduced that to22.8mib. this supports retained per-connection demand,
not an established unbounded per-request leak. postgres memory contexts explain
only part of the resident allocation; native allocator versus emulation effects
remain unattributed.

limits: production amd64 images ran under emulation on arm64; restored indexes
and planner statistics were rebuilt, and connection workload was representative,
not a recovered historical per-backend sequence. four is not a qualified pool
setting. private plans, measurements and results are retained in
`nexus-search-profile-20261026-bzr4ivr6`; the diagnostic containers, volume and
network were removed and the host slot released. application and production
state were unchanged. see the linked connection-budget issue for repair scope.
