# local docker stopped-container inventory

status: reopened; origin: 2026-10-03 selection-concurrency allocation; area: local tooling.

full `docker ps -a --no-trunc` again exits 1: `rw layer snapshot not found for container 1303c215bf960cd4f0ce7f293dbf90d13b1753f9171b2c202b1511635e15d349`. direct inspect reports that pre-existing container present/exited; running-container, network and volume enumeration succeed. receipt: `/tmp/nexus-cleanup-20261003-nexus-selection-concurrency-protected-inventory.json`, sha256 `8ab466245f843b9afa4a967db621f1d084fa2178d96612d4724d5667ec601903`.

this prevents a complete stopped-container inventory and historical preservation comparison. exact proposed names are checked directly; no task repairs or prunes docker. the earlier successful enumeration justified retiring the old open item; this is newly observed recurrence, with no recovery-cause claim.

prerequisite: explicit host-maintenance scope. inspect the missing snapshot and restore ordinary full enumeration without deleting unrelated resources. acceptance: full enumeration succeeds and the current pre-existing container facts are reconciled; preserve the unavailable historical comparison as a limit.
