# docker filesystem became read-only during qualification

status: open; runtime recovered, host cause unresolved
origin: 2026-10-14 libraries implementation; baseline `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: local verification infrastructure

at 2026-10-15 06:55 utc, docker's vm log reports postgres cannot open
`base/5/2601` and `global/1262`: `Read-only file system`. container log writes
also fail. evidence: `~/Library/Containers/com.docker.docker/Data/log/vm/init.log`;
the rotated log is `init.log.20261014-235448.459`. `docker info` exceeded a
six-second bound; the isolated auth request reset. the host data volume reports
3.3 gib free, 100% capacity. causation is not established.

libraries baseline reds completed before the incident. candidate qualification
stopped before its first case; these infrastructure failures are not product
results. this task issued no docker restart. toolbar reports suggestions had
already repaired the engine before its proposed restart window; toolbar also
issued no restart. normal small workloads were released on 2026-10-15. this
task resumed only its own existing app database/minio and checked auth health,
`select 1`, then ordinary bff/api creates, public reads and fixture deletions.
candidate qualification subsequently passed. host free space remains about
3.9 gib; large restores stay off this mac. no prune/reset or production action
occurred; every other task's containers and volumes were preserved.

remaining work: establish the read-only filesystem's cause and repair it at
the host/storage owner. preserve unrelated task data. earlier virtualization
crashes have a [separate record](docker-desktop-virtualization-crash.md); a common
cause has not been established.

acceptance: identify and resolve the underlying host incident, with bounded
engine/auth/database probes and ordinary transactions still healthy. runtime
recovery and successful qualification alone do not resolve the unknown cause.
