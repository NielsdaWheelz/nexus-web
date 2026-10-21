# lab startup timed out under swap pressure

status: open
area: local verification infrastructure

during 2026-10-20 unsaved-work qualification, host free space fell from 50 gib
to 11 gib with 29 gib of allocated swap. lab `20261020-111233-b8c33cd182cb`
timed out starting postgres/storage after 120 seconds, before its driver ran.
its artifacts occupied 23 mib; teardown completed and unrelated services stayed
healthy. the bounded backend-log read showed no space error, so the cause is
unproved. evidence was recorded in commit `1c73d0ca9`,
`docs/issues/macbook-docker-storage-headroom.md`.

storage cleanup restored headroom but does not establish this timeout's cause.
resolved when the startup failure is explained and the affected services reach
readiness under the intended local workload after the identified correction.
