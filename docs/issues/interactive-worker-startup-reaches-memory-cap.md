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
ordinary tool-using chat check.

## memory successor

exact successor5acb211a settled succeeded at20:27:05 utc. the new interactive
worker retained185.410/320 mib through20:28:29 with zero limit/oom/swap/restart
events. this covers startup and release probes; representative new tool-using
chat and recovery remain pending. keep this ticket open.

## 2026-10-14 production recurrence

production `b6768bee2469cbc3a43902302836a44d07a11ea7`, worker
`sha256:9b5fe72a1aae235446a727608564109c04cf55c364fb1c9491219ba6d18139c4`:
the same interactive-worker epoch accumulated six `memory.events.max` events
between the last observation at 09:05:49 utc and resumed observation at
12:21:56 utc. oom, kill and restart counters did not change. timing and request
attribution within that gap are not observed. the fresh charge was 309055488
bytes against 335544320. distinguish file-cache reclaim from anonymous demand
before judging the incident or the staged release's combined capacity allowance.

evidence: campaign `release/capacity-2g-reaudit-20261014/observer-resume-20261014T122157Z.json`,
receipt sha256 `0255897895fa1f6070168f8c676ab370340e74452023d083851efff5dc1ef072`.
the staged lazy-provider composition has independent import evidence; its real
production worker journeys and operating margin remain to be qualified.

continued production observation, 12:21:56–13:17:16 utc: the same worker epoch added 19 limit events (6→25), with no oom, kill or restart. transient anonymous memory reached 314.0742 mib; peak charge was 319.4727 against 320 mib. current sampled anonymous memory later fell to about 299.9 mib, which must not replace the transient in capacity planning. all four SDKs warmed in the corrected import comparison show no permanent memory saving; selected cold codex imports alone save about 75.7 mib. the conservative mixed-time allowance arithmetic is 808.7534 mib against 832, a 23.2466-mib estimate rather than measured coincident reserve. historical native-host kernel composition remains uncertain. actual corrected production journeys remain pending. evidence: campaign `capacity-2g-reaudit-20261014/aggregate-control-31d69ff7/attempt4-evidence/` and host observer interval receipts.

## 2026-11-24 production kill

at 03:02:27 utc, the installed `e3d835268` interactive-worker cgroup hit
its 320 mib cap and the kernel killed python. generation
`b5626df2-6cac-4703-8867-0ce4c4c999dd` (`gemini-4-carbon`, `medium`)
settled interrupted without usage. the worker restarted. the preceding
native sol, metered sol, fable and astra runs completed. all five used
`ChatReadAdditiveWrite` with capture off. at the kill the cgroup held
333,414,400 anonymous bytes and 4,096 file bytes. delivery and the exact
allocation remain unknown.

on the macbook arm64 worker, cold carbon peaked at 273,379,328 bytes. at
320 mib the metered sol and fable web reads reached the cap. observation
stopped before astra. one 448 mib epoch completed all four warm-ups and three
matched carbon sends. each used 25,522 assembled input bytes. the carbon
peaks were 423,665,664, 437,116,928 and 436,834,304 bytes. anonymous charge
settled at 337,969,152 bytes after each. the installed incident's assembled
size is unknown.

the 544 mib candidate covers the 416.9 mib observed peak, a provisional 80 mib
platform/workload allowance and 32 mib operating reserve, rounded up to
32 mib. the allowance uses an unpaired 65 mib native anonymous-charge
difference between hosts as a sizing input. the reserve covers the 28.3 mib
cross-epoch native peak difference and 12.8 mib warm carbon range.

at 09:40–09:42 utc, installed `ad3288b03` completed all seven dedicated-account
sends in one worker epoch. its peak was 375,664,640 bytes, leaving 194,760,704
bytes of the 544 mib cap against the frozen 32 mib reserve. the restarted
database retained at least 2,065,575,936 bytes of reserve. the lowest sampled
host availability was 4,578,185,216 bytes. the connector ran during the sends.
swap, oom events, kills and worker restarts stayed at zero. all seven used 25,522
assembled input bytes and the incident's tool plan with capture off.

the original generation's assembled size, provider delivery and allocation
site remain unknown. closure requires evidence that explains that kill.
