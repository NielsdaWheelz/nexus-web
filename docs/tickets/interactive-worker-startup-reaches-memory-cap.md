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

capture cgroup `memory.stat`, pressure and proportional process memory during
manual observation of representative interactive work through the product
owner. identify the dominant allocation before changing imports or
limits. keep the restored background child-process architecture; its supervisor
stayed near 96 mib rss, and this run provides no reason to copy the legacy
lazy-provider implementation. do not recreate a removed test suite.

## acceptance

representative interactive work completes under the canonical cap with owned
health, no oom, and measured remaining capacity; explain the startup limit
events or fix the demonstrated allocation at its owning boundary. retain the
exact image, machine and measurement limits.

## subsequent exact-image failure

`959afa760037fd9f12ad61265f502348533d5ee1` / worker
`sha256:63fe7e8859e1489e15c5594a095814f6bd7bc46060f21416a61a54d95f218a2f`
was measured on `dev-server` at 15:40–15:41 utc. background reached health in
16.75s and passed seven cycles (350,900,224-byte peak). the interactive worker
started at 15:41:27 and was oom-killed at 15:41:38, exit 137, under its exact
256 mib/no-swap limit. uvicorn/mcp startup completed immediately before the
kill. this is now a demonstrated allocation failure, not merely reclaim.

private receipt: `/tmp/nexus-release-255/worker-smoke-959afa76/receipt.json`
on the mac, with original samples/logs in the matching devbox cache directory.
`memory.stat` was captured. both workers and the disposable postgres are
stopped; production services were untouched. profile startup before choosing
an import/composition fix or a reviewed redistribution of the existing budget.

## production restoration update

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026` succeeded on
`nexus-api-worker` at 2026-09-15 18:37:25 utc. the exact interactive worker
peaked at 185.289 mib under its revised 320 mib cap, with no observed limit,
oom, swap or restart events during deployment. the owned codex qualifier
completed three real turns on the separate credential host. that does not prove
representative interactive-worker execution; keep this ticket open for the
ordinary tool-using chat check. see the [release evidence](../cutovers/restoration-release-2026-09-15.md).

## memory successor

exact successor5acb211a settled succeeded at20:27:05 utc. the new interactive
worker retained185.410/320 mib through20:28:29 with zero limit/oom/swap/restart
events. this covers startup and release probes; representative new tool-using
chat and recovery remain pending. keep this ticket open.
