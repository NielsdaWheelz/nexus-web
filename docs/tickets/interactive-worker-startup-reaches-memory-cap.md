# interactive worker startup reaches its memory cap

status: open · origin: 2026-09-15, pr #255 qualification · area: worker memory

## evidence

exact f353cb3ca0f4859807d9911c4e7a30b4b8af3412 worker image on `dev-server`,
14:37–14:38 utc: the normal interactive worker reached owned health in 16.92s,
published seven advancing health cycles, and exited zero. its cgroup peak was
268,435,456 bytes, equal to the canonical 256 mib cap. `memory.events max`
rose to 14 during startup; oom, oom-kill and swap remained zero. final charge
was 239.50 mib. the worker claimed no jobs. no runtime errors were logged.

receipt and samples: `/home/niels/.cache/nexus-release-255/worker-smoke-f353cb3c/`
on the devbox, mirrored under `/tmp/nexus-release-255/` on the mac. the exact
production configuration used only the isolated, already-migrated clone as its
database; external traffic was blocked. no api or codex readiness is claimed.

this proves startup reclaim pressure, not an oom or a leak. `memory.stat` was
not captured, so anonymous-memory demand cannot be separated from file-cache
reclaim. sampled process rss uses different accounting and cannot substitute.
extra host ram alone does not enlarge this container's fixed cap.

## prerequisites and proposed fix

after the independent host-capacity blocker is resolved, capture cgroup
`memory.stat`, pressure and proportional process memory during the next exact
image qualification, including representative interactive work through the
product owner. identify the dominant allocation before changing imports or
limits. keep the restored background child-process architecture; its supervisor
stayed near 96 mib rss, and this run provides no reason to copy the legacy
lazy-provider implementation. do not recreate a removed test suite.

## acceptance

representative interactive work completes under the canonical cap with owned
health, no oom, and measured remaining capacity; explain the startup limit
events or fix the demonstrated allocation at its owning boundary. retain the
exact image, machine and measurement limits.
