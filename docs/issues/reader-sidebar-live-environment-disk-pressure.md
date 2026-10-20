# reader sidebar live environment exhausted disk

the isolated live campaign stopped producing valid observations after the host
ran out of disk. the web runtime logged `ENOSPC` writing
`.next/server/webpack-runtime.js`; postgres connections then terminated and
docker inventory stopped responding. observed 2026-10-20 utc in the reader
sidebar worktree, before the final same-visit removal checks and static gate.

owned services were stopped and only the worktree's generated `.next` cache was
removed. host free space subsequently recovered to 8.6 gib; database and runtime
health still need confirmation. the owned database on port 29010 refuses
connections; a five-second unix-socket `/_ping` request exits 28 with http 000.
inventory returns 500 and scoped container restarts report
`Docker Desktop is unable to start`. no restart client remains queued.

the owner chose to leave docker unchanged and report verification limits.
temporary tests, scripts, credentials, logs and the baseline worktree were
deleted; owned local processes were stopped. isolated accounts/container data
remain. their ids and scoped teardown commands are in the private, credential-free
`/tmp/nexus-reader-sidebar-20261019-cleanup.json` (mode 0600). inspect only those
containers' mounts after recovery; exact volume names could not be queried.

remaining live checks: same-visit row deletion/unlink focus recovery. a global
highlight deletion that creates another visit is not a valid oracle for that
contract; see [the separate finding](reader-sidebar-removal-focus-recovery.md).
request-race and accessibility gaps have their own issue records.

the unchanged `./scripts/test` static gate passes. the remaining blocker is live
verification and isolated-data cleanup, not static consistency.

resolved when the owned environment serves the remaining live cases, all owned
fixtures/services can be cleaned up, and the unchanged static gate passes.
