# back to a long outline reopens its first 48 rows

problem: an outline that showed more than one window (60 rows typed in place, or
`show more items`) is rebuilt on back with a fresh controller whose root request
reads the first 48 rows (`useLocalOutlineRoot`'s default request,
`apps/web/src/components/notes/LocalOutline.tsx`). the pane's return memento
places its eye-line anchor correctly, but when the remembered position sat near or
past row 48 the shorter content clamps the scroll, or the anchor row is not shown
at all and the raw scroll offset stands in.

impact: back from a note opened low on a long page lands the page short of where
it was. rows past the first window must be shown again by hand. session fold
state and occurrence anchors survive return; this record concerns only the
window's extent.

evidence: run `20261102-120747-44125980ad46` (case `outline-zoom-08-return`):
before leaving, rows 1–60 shown and row 40 at 120px; after back, rows 1–48 and
`show more items`, row 40 at 149px with the scroll at its maximum. the case now
holds row 40 low in the port, where 48 rows suffice.

proposed fix: retain the root request's window (cursor or anchor) with the visit,
beside the pending input the visit already retains, so the remounted outline
reopens the window it showed.

resolved when: a lab case scrolls a 60-row page to row 55, opens its bullet, goes
back and sees row 55 at its former offset.
