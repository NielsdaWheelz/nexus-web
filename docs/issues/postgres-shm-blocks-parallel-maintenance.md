# postgres /dev/shm blocks parallel maintenance

**problem.** the production `postgres` service (`deploy/hetzner/docker-compose.yml`) runs
with docker's default 64 MiB `/dev/shm`, a 512 MiB memory cap and postgres's default
parallel settings. a parallel `VACUUM` puts its dead-tuple store (sized by
`maintenance_work_mem`, 64 MB there) in a dynamic shared memory segment under `/dev/shm`;
it does not fit and the command fails `DiskFull`. afaict a parallel index build
(`max_parallel_maintenance_workers`) and a large parallel hash join (shared hash table,
`max_parallel_workers_per_gather`) take the same path; neither has been reproduced.

**impact.** a manual `VACUUM` or `VACUUM (ANALYZE)` after a restore, a bulk delete or a
migration fails unless it says `PARALLEL 0`; a parallel `CREATE INDEX` or a large
parallel query may fail the same way. autovacuum is not parallel and is unaffected.

**evidence.** the 665-backup rehearsal under the production limits (pinned image,
postgres 15.17, 512 MiB, no swap, `shared_buffers=64MB`, `jit=off`, 64 MiB shm):
`nexus-web-campaign-artifacts/2026-10-14/rehearsal/rehearsal-0278-0282.md` (restore):
the post-restore `VACUUM (ANALYZE)` failed `could not resize shared memory segment
"/PostgreSQL.…" to 67145280 bytes: No space left on device`; `VACUUM (ANALYZE, PARALLEL
0)` passed in 4.3 s. the two later records beside it (`rehearsal-0278-0283.md`,
`rehearsal-0279-0283-at-0278.md`) ran `PARALLEL 0` for the same reason, with
`--shm-size 64m` explicit.

**candidate fixes.**
- raise `shm_size` on the `postgres` service. shm pages are charged to the container's
  memory cgroup, so the size must leave the 512 MiB cap its headroom.
- add `-c max_parallel_maintenance_workers=0` beside `jit=off`: maintenance runs serial;
  parallel queries are untouched, so a large parallel hash join is still exposed.

**resolved when** a parallel `VACUUM (ANALYZE)` on a restored backup under the
production limits succeeds.
