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
