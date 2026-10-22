# campaigns measure load with host cpu burners

status: open. burner and load-average guidance is retired; its calibrated
replacement is not yet qualified. calibration and the 20-run repeats
remain deferred to slice 6, after the operator resize window. ask for owner
approval before calibration or the 20-run repeats.

problem: historical campaign "under load" runs started `nice -n 19` busy loops
across the whole host and accepted a run when the host load average exceeded 10.
examples:
- `loaded.sh` defaults to 16 burners; the c3nt port ran `BURNERS=24`.
- `journeys/run.mjs` logs `os.loadavg()`.
- `notes/design.md` §12 O-1 sets the criterion, and
  [notes-redo-of-split-refused](notes-redo-of-split-refused.md) uses it in its
  historical resolution check.

the property under test is that journeys survive a slow client, but burners also
slow the playwright driver, the fakes, the api and every other session on the
host.

impact: results are not reproducible, and they mix product tolerance with harness
starvation. the host is degraded for all other work.

evidence:
- 2026-10-21: host load 147-162 with 24 burners on 18 cores, which dropped to 16
  when the run ended.
- `notes/fix.md:61-64`: loads of 16-186, and one journey's first click timed out
  at about load 186.

fix: cdp client throttling, calibrated against the refused-redo xfail
([lab-host-budget](lab-host-budget.md) §5, macbook-capacity d4).

resolved when the calibrated throttle reproduces that xfail on the base sha and
no campaign starts host burners.
