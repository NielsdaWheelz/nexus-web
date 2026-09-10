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
