# local docker stopped-container inventory

status: open, intermittent; origin: 2026-10-03 selection-concurrency allocation; area: local tooling.

initial full `docker ps -a --no-trunc` again exited 1: `rw layer snapshot not found for container 1303c215bf960cd4f0ce7f293dbf90d13b1753f9171b2c202b1511635e15d349`. initial inventory sha256: `8ab466245f843b9afa4a967db621f1d084fa2178d96612d4724d5667ec601903`.

final cleanup full enumeration exited 0; direct inspect exited 0 and found that same container present/exited. retained receipt: `/tmp/nexus-cleanup-20261003-nexus-selection-concurrency-summary.json`, sha256 `3b91395c51fb674603803232f4f0c7aa73bb4c1e7bba8457567acb0cae0e5e3f`. no host repair or prune occurred; recovery cause is unknown. the recurrence remains open despite this healthy read. the unavailable initial stopped-state comparison is a historical evidence limit, not a repair target.

at 2026-10-03 12:43:46 utc, row-contract discovery full enumeration again exited 1 with the same snapshot error/container id. before-creation inventory: `/tmp/nexus-cleanup-20261003-nexus-row-contract-protected-inventory.json`, sha256 `23601c3b707270b98a49869c7bad5ca6faa20452b5aa2a222b5634e003d4c857`. no host change was attempted.

next action: retain command/container facts on recurrence and establish its cause before selecting any separately authorized host change. acceptance: establish the recurrence's cause and resolution with ordinary full enumeration working; one healthy listing alone does not qualify.
