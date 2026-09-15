# The mobile switchboard's Account-menu host has no proof

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W2, 2026-09-09; the residue
of OI-016 that `components/appnav/NavRail.browser.test.tsx` did not close
**Area:** `apps/web/src/components/switchboard/SwitchboardTask.tsx`

## What is wrong

Contract D9 makes the shared `AccountMenu` item `Imports` the mobile entrance to
`/imports`. The item itself — its offer, its `href`, its badge, its
`aria-current`, and the pane it opens — is now proved by
`NavRail.browser.test.tsx`, which renders the real menu from the rail's own
Account trigger. Its **mobile host** is not: nothing renders `SwitchboardTask`
or asserts that it passes an `accountMenu` into the switchboard pages with the
same `utilities={NAV_UTILITIES}` and `utilityActiveId(activeDestinationId)` the
desktop rail passes (`SwitchboardTask.tsx:239-244`).
`rg -l "SwitchboardTask" apps/web/src --glob '*.test.tsx'` returns nothing.

A defect in that wiring — a missing `utilities` prop, a stale
`utilityActiveId`, or an `accountMenu` that never reaches the page — would
remove or mis-mark the Imports entrance on mobile with every proof still green.
The gap predates this cutover and covers the Stats and Settings entrances
equally.

## Prerequisites

A renderable harness for `SwitchboardTask`: it has never been rendered by a
test, so this proof has to establish one (read how the switchboard page composes
its providers, the way `NavRail.browser.test.tsx` copied the minimum from
`AuthenticatedShell`). That is why OI-016 was closed on the menu item rather
than on its host.

## Proposed fix

A browser proof beside `SwitchboardTask` that renders it at the mobile viewport
and asserts the page receives an Account menu offering `Imports` with the
attention count and `aria-current="page"` while the workspace is on the pane; or
a mobile-viewport step in `durable-ingest-reader-open.journey.spec.ts` that
reaches `/imports` through the switchboard's Account menu.

## Acceptance

A named case fails if `SwitchboardTask` stops handing the switchboard pages an
Account menu, stops passing the utilities, or passes a `utilityActiveId` that
does not follow the active destination.
