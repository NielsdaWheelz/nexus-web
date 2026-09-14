status: open
origin: 2026-09-13 bounded-workspace implementation
area: verification / external fixture ownership

the actual PDF/EPUB schema-two fixture producer cannot start its external test
origin while a separate legitimate controller owns loopback 19091. receipt
`d3c259c2a70bf357`: `owned external process cannot start: loopback port 19091 is
already in use`. listener PID3156248 belongs to
`nexus-web-db0215-bridge.sii9up/checkout` and active controller PID2950592.

the controller allocator probes ports initially but persists its runtime selection.
this worktree selected 19091 while idle; a foreign worktree subsequently claimed it.
`services.py:143` is a default, not a fixed process definition.

prerequisite: that owner releases the port, or a fresh owned proof worktree uses
the existing allocator while 19091 is occupied. do not kill foreign processes or
retry without an ownership-state change. a controller improvement should resolve
this persisted-idle allocation race at its existing ownership boundary.

acceptance: run the real source producer through `./scripts/test`; retain valid
PDF and EPUB schema-two archives, then consume them in the native composed proof.

2026-09-13 recurrence: the owned fresh publication-proof checkout also selected
19091 during an idle window. `2f2990f4c4206ff1` passes the table kernel, then fails
before publication ownership service proofs with the same owned-external-protocol
port conflict. a fresh checkout is only a contingent unblock, not a correction
of cross-checkout reservation. no foreign resource was modified.

2026-09-13 image-decoder verification recurrence: `d6988c1a327c5dfb` reaches real infrastructure setup but cannot start its external peer on occupied 19091. no image-decoder assertion ran.
