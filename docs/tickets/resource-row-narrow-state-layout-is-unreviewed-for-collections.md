# The narrow `ResourceRow` state layout changed for Collections with no review

**Status:** open
**Origin:** 2026-09-09, imports workspace hard cutover, chain W1 (raised by the
review of the D15 visual fixes)
**Area:** `apps/web/src/components/ui/ResourceRow.module.css`,
`apps/web/src/components/collections/CollectionRow.tsx`

## What is wrong

The D15 review found each Imports row's status line opening with an orphaned
`·` floating ~220 px from the text it separates. The cause was flex geometry:
in `@container (max-width: 520px)` the supporting cell was `flex: 1 1 auto`, so
it grew past its own text and pushed its separator against the state block on
the far side of the row. The fix makes the supporting cell `flex: 0 1 auto`, so
supporting text, separator and state pack together and adjacency — not leftover
space — positions the dot.

`ResourceRow` is shared. Its other consumer that passes both `supporting` and
`status` is `CollectionRow` (`CollectionRow.tsx:491-492`), whose narrow rows now
carry their state block immediately after the supporting text instead of at the
row's trailing edge. That is the intended reading of a `a · b` meta line, but no
one has looked at it: `CollectionRow.browser.test.tsx` asserts no geometry, the
suite cannot enter the container query (`setViewportWidth` only redefines
`window.innerWidth`; reaching the query needs CDP device-metric emulation, which
no proof here uses), and the D15 capture set contains no Collections row.

## Evidence

`ResourceRow.tsx:62-74` renders `.supporting`, `.stateSeparator` and `.state` as
flex children of `.secondary` under `@container (max-width: 520px)`; `.state` is
`flex: none`, so the supporting cell's grow is what placed the state block at
the trailing edge. `<scratchpad>/evidence/F-imports-review-2/in-progress-counted.png`
(and `history-recovered.png`) show the orphaned separator this changed.

## Prerequisites

A Collections pane capture at a container width below 520 px — either the next
D15 recapture run or any narrow screenshot of a collection with both a
supporting line and a status.

## Proposed fix

Add one Collections row at narrow width to the D15 recapture set and judge the
new packing there. If the trailing-edge state block is wanted for Collections,
the alternative that leaves flex geometry alone is to render `.stateSeparator`
inside `.supporting` in `ResourceRow.tsx` so it can never outlive its adjacency
— at the cost of the separator being clipped when the supporting text
ellipsises.

## Acceptance

The recapture set contains a narrow Collections row, and the review records that
its supporting/status line reads correctly — or `ResourceRow` is changed so both
consumers keep the layout they had.
