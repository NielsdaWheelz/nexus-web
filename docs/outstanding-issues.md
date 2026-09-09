# Outstanding Issues & Follow-ups

A register of **open code-level work** — issues found but left out of scope, bugs,
refactors deferred because they were too much churn, and things that warrant a
closer look later. **Add entries as they surface; delete them once resolved (record
the fix in the commit/PR). This doc tracks only outstanding work, never history.**

It is **not** a checklist for routine verification (running test / e2e / CSP
suites), release process (commit / PR / merge), or already-settled design decisions
— those belong in CI, the PR, or the relevant spec/memory.

The register is repo-wide: tag each entry with an `area`.

## How to add / update an entry

- Copy the template below, give it the next free `OI-NNN`, append it under `Open`.
- **Statuses:** `OPEN` (actionable now) · `DEFERRED` (blocked on a decision or
  another change).
- Keep the one-line metadata: `area · opened YYYY-MM-DD by <name/agent> · P0–P3`
  (P0 = ships-blocking, P3 = nice-to-have).
- When an entry is resolved, **delete it** — record the fix in the commit/PR.

```
### [OPEN] OI-000 — <short title>
area · opened YYYY-MM-DD by <who> · P2
<the code issue / bug / investigation, why it matters, and how to resolve>
```

---

## Open

### [OPEN] OI-003 — Imports live re-read loses one tick after a failed re-key
frontend · opened 2026-09-08 by Claude (imports cutover, Track D2) · P3
A manual refresh or invalidation whose own summary read fails re-keys the page
and detail without delivering a tick, so the next successful observation is
suppressed and the 5 s cadence of contract D10 slips once. See
[docs/tickets/imports-live-reread-loses-one-tick-after-a-failed-rekey.md](tickets/imports-live-reread-loses-one-tick-after-a-failed-rekey.md).

### [OPEN] OI-004 — An Imports invalidation unmounts the rows it is refreshing
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P3
Every invalidation re-keys `useImportsPage`, so the visible rows unmount for one
round trip and any row-local state goes with them; the false empty state this
caused is fixed, the churn is not. See
[docs/tickets/imports-invalidation-unmounts-the-visible-rows.md](tickets/imports-invalidation-unmounts-the-visible-rows.md).

### [OPEN] OI-005 — The Imports upload retry guard cannot check the file's size
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P3
`ImportItem` carries no upload size, so a same-named file of a different size is
now refused by the server after its bytes are sent instead of by the browser
before. See
[docs/tickets/imports-upload-retry-cannot-check-the-file-size.md](tickets/imports-upload-retry-cannot-check-the-file-size.md).
