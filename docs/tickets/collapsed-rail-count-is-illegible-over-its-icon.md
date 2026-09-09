# The collapsed rail paints its attention count on top of the Imports icon

**Status:** open
**Origin:** Imports workspace cutover, Track F chain F-fix3, 2026-09-09, found in
the D15 collapsed-rail review artifact once the capture waited for the rail's
width to settle
**Area:** `apps/web/src/components/appnav/AppNav.module.css` (`.utilityChip`);
`apps/web/src/components/imports/ImportsBadge.tsx`

## What is wrong

Collapsed, the rail is 48 px wide (`--navbar-collapsed-width`) and the Imports
link is icon-only, so `NavRail` wraps the badge in `.utilityChip`
(`position: absolute; top: 2px; right: 2px`). The `Pill` it paints is about the
size of the icon itself, so the chip lands *over* the `ListTodo` glyph rather
than beside or above it: in the review capture the circle and the icon strokes
overlap and the digit inside the chip cannot be read.

The count is present and the link's accessible name still carries it exactly
(`link "Imports, 1 needs attention"`), so this is a legibility defect, not a
missing badge — a reader with one import needing attention sees a smudge where
the expanded rail shows a clean `1`.

## Evidence

- `<run>/playwright/…/imports-review/rail-badge-collapsed.png` (journey runs
  19d5f6fd6b63526f and 48d7a2b4bb8f5b23; copied to the chains' evidence
  directories as `F-imports-review-2/` and `F-imports-review-3/`) — the
  collapsed 48 px rail with the chip over the icon.
- `F-imports-review-3/rail-badge.png` — the same badge in the expanded rail,
  where the `Pill` reads cleanly beside the label.
- The badge's label-hidden branch is proved by
  `ImportsWorkspace.browser.test.tsx::"keeps the capped count painted when the
  chrome hides its label"`, which renders the badge alone: it asserts the count
  is painted rather than clipped, and says nothing about the rail's chip
  geometry. No proof renders `NavRail` collapsed at all.

## Prerequisites

None. It is a rail presentation change owned by `AppNav.module.css`, and it
wants the content/visual reviewer's eye (spec D15) rather than a new mechanism.

## Proposed fix

Give the collapsed chip its own surface: a smaller `Pill` (or a dot with the
count in the accessible name only) offset to the icon's corner with an opaque
background and a hairline ring against the rail, so the digit reads over the
glyph. Whichever shape is chosen, keep `ImportsBadge`'s accessible name exact —
the visible count may cap or disappear, the name may not.

## Acceptance

The collapsed-rail review capture shows a count a reader can read at 100% zoom,
`rg -n "utilityChip" apps/web/src` still resolves to one owner, and
`ImportsBadge`'s accessible name is still exactly `Imports, N need(s) attention`
in its badge case.

The existing label-hidden badge case cannot witness this fix: it renders the
badge without the rail's chip wrapper, so it stays green under every chip
geometry. Witnessing the fix needs the recorded capture plus, once the chip has
a surface of its own, a case that renders `NavRail` collapsed and asserts the
chip's painted box does not cover the icon's.
