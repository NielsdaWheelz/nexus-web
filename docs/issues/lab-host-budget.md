# unattributed docker desktop writes

status: open · 2026-10-22 · area: host write attribution. the lab/campaign runtime,
image ownership, ordinary/exclusive admission, fresh-data web reuse and client
throttling are implemented. the 8 gib/8 cpu maintenance and concurrent ordinary
lab acceptance are complete. the remaining acceptance is attribution of 80% of a
full day's vm writes.

[testing-standards](../local-rules/testing-standards.md#disposable-verification)
owns the implemented contracts, including the selected client throttle and its
explicit synthetic calibration control. shared host decisions remain owned by
dev-server `docs/macbook-capacity-plan.md`. optional release-image filesystem
hygiene was explicitly skipped; it is not an acceptance gate.

unconfirmed operator candidates remain intact under the separate conditional
[maintenance leftovers](lab-maintenance-leftovers.md) follow-up. `c3rh-pg` and its
data remain release-rehearsal state. no general cleanup is authorized by this
measurement issue.

## measurement and acceptance

about 150 of the 231 gb docker desktop wrote in 28 h has no named source. measure
it before claiming checkout image and web package reuse suffice:

- host: pin the virtualization vm process identity and sample its
  `ri_diskio_byteswritten` (`proc_pid_rusage`) every minute. join samples to lab
  run timestamps for per-run and idle volume.
- guest: one cached owned utility serves the whole day, reading completed `vda`
  write sectors and disjoint named cgroup charges. root self-thread dirtying
  stays separate; these counter views are not additive.
- resolved when 80% of a day's vm writes are attributed to named sources.

the fresh observation runs from 2026-10-22 17:06 utc through 2026-10-23
17:06 utc. its fixed 17:06–18:04 utc prefix recorded 991100928 host bytes and
646664192 guest `vda` bytes; 344436736 bytes remain unassigned. no 80% claim
is established. these counters measure different layers: host task-charged io,
guest block io and process page dirtying. root cgroup `io.stat` aliases disk
statistics; parent/child cgroups and waited-child process counters overlap.
missing lifetime edges and host-to-guest accounting remain unresolved; do not
sum these counters or label the residual overhead. the approved bounded host
disk-io trace exposes system-wide disk metadata and paths despite its pid
argument. the initial noninteractive attempt could not start because sudo
required a password. the owner completed the 60-second probe over
18:32:53–18:33:57 utc with the same vm identity, but its write counter stayed
flat and the capture was empty. this does not attribute the earlier residual.
