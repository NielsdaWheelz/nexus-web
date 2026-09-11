# The Imports pane's wrapping geometry has no automated gate

**Status:** open
**Origin:** 2026-09-09, imports workspace hard cutover, chain W1 (raised by the
review of the D15 visual fixes)
**Area:** `apps/web/src/components/imports/ImportsWorkspace.browser.test.tsx`,
`apps/web/src/components/ui/ResourceRow.module.css`,
`apps/web/src/components/imports/ImportsWorkspace.module.css`

## What is wrong

Two of the D15 visual findings this chain closed are facts about layout
geometry, and neither is asserted anywhere:

- `Refresh` "migrates between rows as the filter set changes width". The fix
  gives it a fixed slot beside the search box; whether it stays on one row as
  the filter set grows is a wrapping fact.
- Each row's status line opened with an orphaned `·` ~220 px from the text it
  separates. The fix makes `ResourceRow`'s supporting cell `flex: 0 1 auto`
  inside `@container (max-width: 520px)`; whether the dot is now adjacent is a
  container-query fact.

The browser suite cannot reach either. `setViewportWidth` (test file, ~:636)
only redefines `window.innerWidth` and dispatches `resize`; it does not resize
the Chromium viewport, so no container query changes branch and no toolbar row
re-wraps. A structural stand-in was tried for `Refresh` — asserting the button's
`parentElement` contains the search box — and removed: it asserts DOM parentage,
not the property under review, so it would pass over the reported defect and
fail on a behaviour-preserving refactor (`testing-standards.md` §6, "Test
behavior, not implementation").

Until this is closed, the D15 recapture is the only gate for both.

## Evidence

`ImportsWorkspace.browser.test.tsx:636-641` is the whole width control the suite
has. The same file's touch case does drive CDP
(`cdp().send("Emulation.setTouchEmulationEnabled", …)`), so the transport for
real device metrics is already available in this suite — nothing uses
`Emulation.setDeviceMetricsOverride`. `<scratchpad>/evidence/F-imports-review-2/`
`in-progress-counted.png` and `toolbar-*.png` are the captures that found both
defects.

## Prerequisites

None; `cdp()` is already wired into the Imports browser proof.

## Proposed fix

Add a `setDeviceMetrics(width, height)` helper beside `setViewportWidth` that
sends `Emulation.setDeviceMetricsOverride` and clears it in the case's teardown,
then assert the two properties directly in the cases that already exist:

- with the pane at a mobile width and two filter sets of different widths
  rendered in the same case, `Refresh`'s bounding box `top` equals the search
  box's in both;
- with a row box below 520 px, the separator's bounding box `left` is within a
  few pixels of the supporting text's `right`.

Then delete `setViewportWidth`'s remaining uses if the override subsumes them.

## Acceptance

The Imports browser proof fails when `Refresh` is returned to `PaneToolbar`'s
`controls` slot, and fails when `ResourceRow`'s supporting cell is returned to
`flex: 1 1 auto`; both pass as written today.
