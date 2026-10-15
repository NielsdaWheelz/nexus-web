# local docker storage lacks qualification headroom

status: open; suggestions qualification moved off the mac
origin: 2026-10-15 suggestions implementation, baseline `367da80e0`
area: local development / storage

a large restored-corpus load exhausted shared docker storage. the desktop
backend logged `no space left on device` at 2026-10-15 06:55:43 utc and shut down
its linux engine. evidence: local
`~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log`.
the suggestions-owned duplicate dump and incomplete copied database were
removed; task volumes were preserved. docker recovered, and the coordinated
repair handoff allowed small workloads to resume with about 3.9 gib free.

impact: another large local restore/build can interrupt unrelated task services.
the suggestions corpus qualification now uses a separately owned dev-server
clone; this mitigation does not create local storage headroom.

prerequisite: the storage owner reviews retained artifacts and task volumes.
reclaim or expand capacity through that owner; do not prune/reset shared docker
or delete another task's resources. keep large corpus restores off this mac.

acceptance: documented headroom covers the largest permitted local workload,
and an ordinary auth/data path remains healthy through that workload without
storage errors or engine interruption.
