# The collapsed rail's count capture has no reviewer verdict

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W2 re-review, 2026-09-09.
Successor to OI-032 (`collapsed-rail-count-is-illegible-over-its-icon.md`): that
ticket's geometry clause is fixed and proved, its capture clause is not, and the
ticket was deleted before the capture existed.
**Area:** D15 desktop visual review; the collapsed-rail capture in
`apps/web/e2e/journeys/durable-ingest-reader-open.journey.spec.ts`

## What is wrong

OI-032's acceptance had two clauses. The second — a case that renders `NavRail`
collapsed and asserts the chip's painted box does not cover the icon's — now
exists (`apps/web/src/components/appnav/NavRail.browser.test.tsx`, the two
`paints a collapsed count of N clear of the icon it belongs to` cases, sensitive
to the registered fault `imports-collapsed-count-chip-is-full-size`).

The first — "the collapsed-rail review capture shows a count a reader can read
at 100 % zoom" — is now produced: the D15 journey run records
`F-imports-review-6/rail-badge-collapsed.png`, which paints the count as its own
chip above the `ListTodo` glyph. What is outstanding is the reading of it.
Contract D15 makes the desktop visual review a reported gate and no reviewer has
read the capture, so the gate stays `not_run`.

## Evidence

- `<scratchpad>/evidence/F-imports-review-6/rail-badge-collapsed.png` (Phase 7
  chain Z's journey run `test-results/runs/d651a57479f1f188`, base SHA 26b8161b;
  chain W3's earlier copy of the same state is kept beside it as
  `F-imports-review-6-chainW3/`) — the
  post-fix capture: the count paints as its own chip above the `ListTodo` glyph,
  clear of it, with the rail at its settled 48 px width. This is the artifact the
  ticket asked for; what is still outstanding is the reviewer's recorded verdict
  on it.
- `<scratchpad>/evidence/F-imports-review-2/`, `F-imports-review-3/` —
  `rail-badge-collapsed.png` in each is the chip *over* the glyph, i.e. the
  defect the fix answered.
- Landed geometry the capture should show (measured in the browser proof, rail
  at the default root font size): rail 48 px; collapsed Imports link 31x53 at
  the footer's top; icon 20x20 with its top edge 25 px below the link's top;
  count chip 16x17 (`99+`: 27x17) anchored 4 px below the link's top edge and
  right-aligned to it, so 4 px of clearance sit between the chip's bottom edge
  and the icon's top edge.

The band also makes the collapsed Imports link taller than the Add and Account
controls beside it (53 px against 36 px), unconditionally. That is the price of
keeping the whole chip inside the control it counts for, and it is a second
thing for the visual reviewer to sign off in the same capture.

## Prerequisites

None. Chain W3's journey run took the capture and its bounding-box assertion
(`the collapsed rail painted its attention count over the icon it belongs to`)
passed, so nothing in `components/appnav/**` or `apps/web/e2e/**` is waiting on
another change. What remains is the human half of D15: the visual reviewer has
not yet read the new capture.

## Proposed fix

The capture is recorded. Have the visual reviewer read
`F-imports-review-6/rail-badge-collapsed.png`, confirm the digit is readable at
100 % zoom and sign off the taller collapsed Imports link beside its 36 px
neighbours, then report the D15 collapsed-rail gate with command, SHA and result.

## Acceptance

The reviewer records that the count reads at 100 % zoom in
`F-imports-review-6/rail-badge-collapsed.png` and the D15 collapsed-rail gate is
reported `pass`. The capture clause is met; until the reviewer's verdict exists
the gate stays `not_run`.
