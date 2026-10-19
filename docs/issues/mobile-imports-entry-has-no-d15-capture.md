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
`::after` badge. On mobile that menu is the Nexus switchboard's **Account**
(`components/switchboard/SwitchboardTask.tsx`), not the pane bar's `More`. The
D15 artifact sets capture the desktop entry in both states (`rail-badge.png`,
`rail-badge-collapsed.png`) but never open the account menu, so no set —
`F-imports-review-4`, `-5` or `-6` — shows the mobile entry as pixels.

The accessibility-tree clause is closed: the c2nv nav harness journey
`M11.mobile-account-menu` (2026-10-10, chromium and webkit at 390x844) opens
Nexus → Account, asserts Stats, Imports (with the attention count in its name),
Settings, Sign Out, and saves the menu's aria snapshot
(`nexus-web-campaign-artifacts/2026-10-09/nav/harness/state/m11-account-menu-{chromium,webkit}.aria.yml`).
The `NavRail.browser.test.tsx` this ticket used to cite no longer exists. What
remains is the pixel capture for the human visual gate.

## Evidence

`<scratchpad>/evidence/F-imports-review-{4,5,6}/*.aria.txt`: no file contains an
`Imports` menu item; `zoom-200-430-toolbar-wrap.aria.txt` records
`# mobile pane bar` with `button "More"` and stops there.

## Prerequisites

None.

## Proposed fix

Add one `captureImportsReview` state at a narrow width that opens Nexus →
Account and waits for the `Imports` item before shooting, so the reviewer can
read the item, its badge and their contrast.

## Acceptance

The next D15 artifact set contains a narrow capture of the switchboard's
Account menu with its `Imports` item and count, and the reviewer reports D9's
mobile entry from pixels.
