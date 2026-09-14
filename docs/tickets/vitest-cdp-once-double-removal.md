# vitest cdp once removes its remote listener twice

status: open
origin: 2026-09-13 bounded-workspace browser qualification
area: test dependency / vitest4.1.10

receipt`cdce1eec7c46c50b/component-1.log` retains an unhandled
`TypeError: The "listener" argument must be of type Function. Received type undefined`.
the locked `@vitest/browser/dist/state.js:242-249` once wrapper invokes `cdp.off`;
`dist/index.js:1423-1425` independently removes the same once listener server-side.
its second removal passes the deleted callback to Playwright. the artwork proof
now owns one ordinary on/off listener; no dependency code was changed.

prerequisite: upstream fix or reviewed dependency update. report/fix the duplicate
removal at its owner, then exercise one actual CDP once event through
`./scripts/test`. acceptance: one callback, one remote removal, no unhandled error.
