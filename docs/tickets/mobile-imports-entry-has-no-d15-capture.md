# The mobile Imports entry has no D15 capture

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W4 (second D15 desktop
visual/assistive review), 2026-09-09
**Area:** `apps/web/e2e/journeys/durable-ingest-reader-open.journey.spec.ts`
(`captureImportsReview` states) covering contract D9's mobile entry —
`components/appnav/AccountMenu.tsx`'s `Imports` item and its `Pill` badge

## What is wrong

Contract D9 makes the shared `AccountMenu` item `Imports` (with a real `Pill`
badge) the mobile entry to the pane, replacing the deleted `data-import-count`
`::after` badge. The D15 artifact sets capture the desktop entry in both states
(`rail-badge.png`, `rail-badge-collapsed.png`) but never open the account menu,
so no set — `F-imports-review-4`, `-5` or `-6` — shows the mobile entry as
pixels or as an accessibility tree. The three narrow captures record the mobile
pane bar's `More` button but nothing behind it.

The item is proved by `NavRail.browser.test.tsx` (the shared Account menu's
`Imports` item and its badge), so this is a gap in the human visual gate's
coverage, not an unproved behavior.

## Evidence

`<scratchpad>/evidence/F-imports-review-{4,5,6}/*.aria.txt`: no file contains an
`Imports` menu item; `zoom-200-430-toolbar-wrap.aria.txt` records
`# mobile pane bar` with `button "More"` and stops there.

## Prerequisites

None.

## Proposed fix

Add one `captureImportsReview` state at a narrow width that opens the account
menu (the mobile pane bar's `More`) and waits for the `Imports` item before
shooting, so the reviewer can read the item, its badge and their contrast.

## Acceptance

The next D15 artifact set contains a capture whose tree lists the account
menu's `Imports` item with its count, and the reviewer reports D9's mobile entry
from pixels rather than from the browser proof alone.
