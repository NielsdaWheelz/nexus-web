# legacy host cannot yet admit the restoration

status: open · origin: 2026-09-15, pr #255 release qualification · area: production capacity

## evidence

candidate `f353cb3ca0f4859807d9911c4e7a30b4b8af3412`, host
`nexus-api-worker`: the owned `deploy/hetzner/prove-codex-capacity.sh`
exited before candidate startup at 14:13 utc with
`host memory pressure exceeds the release envelope`. no immutable failed
candidate evidence or application attempt was created.

at 14:27:42 utc, available memory was 399,660 kib and memory pressure
avg10 was some=0.52/full=0.50. all five incumbent services had zero swap.
the codex admission owner (`apps/codex_agent/capacity.py:47`) requires
available memory plus the codex cgroup's current memory to cover its 448 mib
cap and 256 mib of host headroom. the observed pre-codex baseline is about
390 mib. this is an admission deficit, not evidence of a leak or a measured
candidate runtime breach.

after fetching the candidate worker, filesystem free space was
14,374,195,200 bytes. the captured database size was 7,490,108,775 bytes;
the owned backup floor (`deploy/hetzner/release.py:4279`) was
15,248,653,006 bytes. the deficit was 874,457,806 bytes, and the candidate
api image was still absent. remeasure both values before any release.

private receipts: `/tmp/nexus-release-255/capacity-f353cb3c.log` and
`capacity-f353cb3c-operator-receipt.json` on the mac; release preparation
and the database rehearsal use the exact source above. the db0215→db0229
rehearsal passed and its quantified losses and backup limits were accepted.
neither fact proves host capacity.

## prerequisites and fix

qualify the reviewed observed-memory admission on the existing host using newly
published images. retain kernel limits and measured workload evidence. the
user rejected resizing and waived a fresh backup; retain existing archives
and predecessor images. do not reset memory to manufacture a passing sample.

## acceptance

the owned qualifier passes for the exact new candidate on the actual
production host; full candidate images fit available disk and the explicit
backup waiver remains recorded. retain machine, source, pressure, memory and disk evidence. then settle
the no-use window and run the owned release command. no cutover is implied by
this ticket.

## operator decision and cleanup

on 2026-09-15 the user rejected resizing, required minimal cost, authorized
cleanup, and waived a new database backup. cleanup reclaimed 2,615,078,912
bytes; production free space became 16,989,024,256 bytes and journal retention
is now capped at 256 mib. no application container restarted. three obsolete
images and one old restore-drill container were removed; live volumes and
existing archives remain. private details: `cleanup-and-backup-waiver.json`.

the follow-up changes admission from maximum-growth forecasting to observed
headroom and makes small full-pressure readings diagnostic; intrinsic failures
remain failures. it also removes unrelated execution imports from the codex
client. this ticket stays open until the new immutable images pass actual
legacy-host qualification. the resize proposal above is superseded.

## observed-memory qualification attempt

pr #259 merged as `959afa760037fd9f12ad61265f502348533d5ee1`. its direct devbox
check passed. the production qualifier ran at 15:40:14–15:41:22 utc: the exact
codex host and egress policy became healthy, then input materialization failed.
the retained journald traceback identifies `CodexGenerationCapacityUnavailable`
from the authenticated model-catalog call, wrapped as
`GenerationCatalogRefreshError`. no model turns ran; no immutable failed
capacity record or application attempt was created. cleanup stopped the two
candidate services. all five incumbents stayed healthy with unchanged ids.

the materializer's transient footprint and the separate interactive-worker oom
(oi113) require diagnosis before cutover. logs:
`capacity-959afa76-operator-receipt.json`, `capacity-959afa76.log`, and
`materialize-959afa76-journal.log` under the mac's private release directory.

## restored worker and admission measurements

pr #260 merged as `3ee6a9b5935151ed6e73b934c1178dd9040f7278`. exact-image
worker startup on `dev-server` passed: interactive peak 183.57 mib under its
320 mib ceiling; background peak 331.42 mib under 448 mib; no oom or swap.
these bounded startup observations do not prove a real generation job.

the production qualifier retry at 16:25:23–16:26:15 utc reached authenticated
catalogue materialization, then refused the model turns with `not_run`. the
independent 100 ms observer recorded a minimum of 209.93 mib available and
maximum `some avg10=6.7`; no sample fell below 192 mib. no immutable candidate
breach was recorded. see `capacity-3ee6a9b5-retry-operator-receipt.json`,
`capacity-3ee6a9b5-retry-memory-summary.json`, and
`worker-smoke-3ee6a9b5/receipt.json` in the private release directory.

the reviewed single-user operating budget lowers the observed free-memory
floor to 128 mib and permits `some avg10 <= 10`. this accepts a smaller margin
for unrelated allocations and greater reclaim latency; it does not establish
actual generation demand. retain the separate 320 mib host reservation budget,
384 mib codex peak, 448 mib codex ceiling, zero service swap and oom, one-turn
concurrency, and all service-health checks. service ceilings can sum above
physical memory, so individual caps do not guarantee host-wide safety. all three
real qualification turns must pass on the new exact image; `not_run` remains a
refusal. this ticket remains open pending that evidence.
