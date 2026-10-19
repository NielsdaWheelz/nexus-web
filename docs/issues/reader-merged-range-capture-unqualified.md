# merged range capture needs phone qualification

main's x-thread changes replace section-box capture with `rangeBelow`,
`rectAt` and `offsetAt` in `apps/web/src/lib/documentReader/text/geometry.ts`, including
range probes in offscreen units. the native chrome qualification measured
`37dea9e06` before those changes; its timings do not qualify the integrated
reader (`02fe1fa987`, main `d6b73c712`). no regression is established by review.

2026-10-19 recheck blocker: the shared local api serves wire 11 and returns
`426 E_WIRE_MISMATCH` to candidate wire 12; its database is at 0292 while
main includes 0293. the shared corpus has no shadow & claw copy. its original
epub remains available (sha256
`5e89f049ae8dd00b29053ed588e27e4d0ae5852225a96ab164827f90563ce0d3`).
upgrading unrelated shared services is outside this merge/cleanup.

resolved when: a matching api/database and disposable book copy support
native first-traversal and warm flings on the samsung sm-s906w. record p95
scroll work below half the observed display interval, no app-owned task
at least 50 ms, continuous visible motion and correct passage preservation.
attribute and repair any failure before closing.
