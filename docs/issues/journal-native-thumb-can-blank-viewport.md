# journal dates can disappear during a native thumb seek

in stock headless firefox on macbook, open a 320-day journal at its newest
date, press the native thumb and drag to three quarters of the scrollbar.
keep the pointer down before making any change to the journal. the pane
records a seek and advances from 0 to 78,947 px. its 101,636 px extent stays
fixed while the visible date disappears for at least 12 seconds. the head
articles remain mounted above the viewport.

the pre-rank revisions `d50d0af60` and `e440` reproduced this with all 320
dates in the local register. the typed calendar also reproduced it.
a diagnostic direct read returned the correct 64 dates for ranks 192–255
from firefox sqlite at the held revision. synchronous publication from the
live pane motion still left the viewport blank. the one-year compact
description also reproduced the same first seek with all 320 keys admitted.

the sealed runs are `journal-d50-exact-first-seek`,
`journal-unranked-exact-first-seek`, `journal-ranked-live-motion-publish`
and `journal-compact-year-stock-motion` under the index-scrolling review.

resolve when the actual native seek presents the captured landing date
during the hold and release preserves its line within one css pixel.
repeat with and without a commit during the press. reads of unseen ranks
after a revision change have a separate [captured-order issue](authored-sparse-motion-old-rank.md).
