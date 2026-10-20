# Docker Desktop VM repeatedly exits during verification

**Status:** blocked on external host virtualization stability
**Area:** local verification infrastructure
**Observed:** 2026-09-09, shared-kernel worktree

Docker Desktop 4.67.0 on macOS 26.4.1 stopped its Apple Virtualization VM at
11:51:04 and 11:57:13 PDT with `VZErrorInternal`. The reported
`use of closed network connection` follows ten seconds later during cleanup.
No VM out-of-memory kill or host disk exhaustion was found. The macOS CPU
resource report explicitly says no action was taken. Workload causation is
unproven; this task's added Linux runner was active near the failures.

All task-owned Docker test processes are paused. No global restart, reset,
prune or settings change was performed. The unavailable daemon rejected an
attempt to stop only `nexus-shared-kernel-runner`. Its named workspace/cache
volumes and controller-owned interrupted resources require safe scoped cleanup
after recovery. Preserve all other worktrees' containers and volumes.

The owner updated Docker to 4.90.0 (Engine 29.7.2). The extra Linux runner was
confirmed exited before one small PostgreSQL scheduling proof resumed. The VM
again stopped with `VZErrorInternal` at 12:09:19 PDT and Docker automatically
restarted it. Updating did not resolve the observed crash. Local Docker
verification is paused again; use the repository's Linux CI for remaining
qualification while the host issue is investigated. Host controller runs
`6a15d716922698b2` and
`767029063b07431b` failed with cleanup errors and are not passing evidence.

2026-10-15 06:54–06:56 utc, inspector/libraries qualification: the shared engine
became unavailable again. a bounded `docker version --format
'{{.Server.Version}}'` timed out after 7 seconds; task api `:8198/readyz`
reported `unavailable`; task auth `:59461/auth/v1/health` reset the connection
(`curl` exit 56). the libraries coordinator independently observed a stalled
`docker ps` and auth reset. vm `init.log` rotated at local 23:54:48.459.
these observations do not establish the current cause or a virtualization crash.
both tasks held live qualification; no restart, reset, prune or shared mutation
was issued by inspector. preserve all worktrees' services and volumes.

recovery coordination moved to toolbar `t-d54f30ad71761fc2`, with release consulted.
the coordinator reports isolated databases failing with `readonlyfilesystem`;
inspector's host `df` independently reports 100% capacity, 3.9 gib available.
inspector removed only its newly created detached-build cache (494 mib), retaining
the completed artifact; no shared docker data was removed. restart ownership
must be confirmed through toolbar before a normal desktop restart.

the coordinator subsequently reported suggestions had repaired docker before
toolbar's window; toolbar issued no restart. daemon queries and auth health
recovered. inspector restarted only its existing postgres, minio and worker
containers, preserving their volumes. ordinary password auth and article/library
reads passed, followed by the recovered chromium matrix and focused firefox/
webkit checks. no inspector restart of docker, prune, reset or production
operation occurred. the immediate interruption is recovered; its cause and the
historical virtualization failures remain unresolved.

next: investigate host capacity and engine failure evidence before attributing
the recurrence. coordinate any shared-engine operation through the active owner;
preserve every task's volumes. repeated healthy task checks establish recovery,
not a durable repair of the underlying host issue.

2026-10-20, unsaved-work qualification: an owned store start timed out; the
backend process then disappeared and the socket refused daemon connections.
the owner approved a normal desktop restart. engine 29.7.2 answered afterward,
the six previously running unrelated services resumed, and host availability
returned to 45 gib. no prune, reset or volume deletion occurred. this establishes
recovery only; the backend exit's cause remains unproved.
