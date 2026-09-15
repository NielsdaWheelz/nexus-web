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

keep production on the incumbent source/schema. review actual memory demand
and a concrete host-capacity intervention; separately inventory any disposable
disk objects. obtain authorization for additional destructive cleanup, a
maintenance interruption, or paid capacity. do not weaken admission, discard
retained backups/predecessor images, or reset memory merely to manufacture a
passing sample. the runbook's manual retained-swap restart exception does not
apply to these zero-swap incumbents.

## acceptance

the unchanged owned qualifier passes for the exact candidate on the actual
production host; the full candidate images and final backup fit the owned disk
gate. retain machine, source, pressure, memory and disk evidence. then settle
the no-use window and run the owned release command. no cutover is implied by
this ticket.
