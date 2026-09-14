status: open
origin: 2026-09-14 published-query consumer audit
area: reader contents residency

`apps/web/src/lib/reader/useReaderContents.ts` stores `Ready.page` directly in
react state. cleanup schedules `setResult(null)` and immediately releases the
index lease. `PublicationSectionControls.tsx` has the same issue through its
state-held `lease.context` and context-capturing click callbacks. the old state can still retain the decoded page until react commits
that update; scheduling a state change is not synchronous payload retirement.

keep the actual page in its existing request owner and expose only the current
owned result to rendering, or retain its exact charge through committed consumer
retirement. no additional cache or lifecycle is needed.

acceptance: withdraw/change a visible contents page while holding its current
render commit; no decoded page survives uncharged, and the exact replacement or
unmount releases old payload and row dom. preserve first/next/retry and authored
hierarchy assertions.
