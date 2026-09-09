# The mobile Account-menu entrance to Imports has no proof

**Status:** open
**Origin:** Imports workspace cutover, Track E second re-review, 2026-09-08;
widened by Track F's re-review; narrowed to this one behaviour on 2026-09-09
once `ImportsPaneBody.browser.test.tsx` landed
**Area:** `apps/web/src/components/appnav/AccountMenu.tsx`;
`apps/web/src/components/switchboard/SwitchboardTask.tsx`

## What is wrong

Contract D9 makes the shared `AccountMenu` item `Imports` the mobile entrance to
`/imports`, carrying the same `ImportsBadge` the rail link carries and marking
itself current from `utilityActiveId` (`navModel.ts`). No proof clicks that item,
reads its `aria-current`, or renders it at all: `rg -l "AccountMenu|NavRail|
SwitchboardTask" apps/web/src --glob '*.test.tsx'` returns nothing, and the
journey reaches the pane through the desktop rail link.

The two behaviours this ticket was opened with are now proved and are no longer
part of it:

- the pane's one `ShellScroll` readiness token, including a first read that
  fails and leaves no list to settle, and
- the `imports-inspector` secondary group: a `?selected=<ref>` deep link opens
  the inspector, and dismissing the mobile sheet leaves the reader on the list
  with the selection the URL still names

— both owned by
`apps/web/src/app/(authenticated)/imports/ImportsPaneBody.browser.test.tsx`.

## Prerequisites

A renderable harness for one of the two chromes. Neither `AccountMenu` (through
`NavAccount`/`NavRail`) nor `SwitchboardTask` has ever been rendered by a test,
so this proof has to establish that harness rather than reuse one; that is why
Track F did not write it inside the pane-body proof, whose subject is the pane.

## Proposed fix

Either a browser proof beside `AccountMenu` that renders it with
`utilities={NAV_UTILITIES}` and a `utilityActiveId` of `imports`, asserting the
item's badge, its `href` and its `aria-current`; or a mobile-viewport step in
`durable-ingest-reader-open.journey.spec.ts` that opens the Account menu and
reaches `/imports` through it.

## Acceptance

A named case fails if the Account menu stops offering `Imports`, stops naming
`/imports`, stops carrying the attention count, or stops marking itself current
while the workspace is on the pane.
