# a drop parked on an unloaded parent can land late or inside another gesture

problem: a drop onto a closed or unloaded parent opens it and parks the gesture
(`OutlineController.place`, `placing`); the rebuild that first shows that parent's
window plans the parked drop as its first child (`rebuild`'s tail). three edges
follow from that shape, none cased:
- a failed branch read leaves the drop parked with no message; when the reader
  retries the read, possibly much later, the drop lands then.
- the epoch guard voids a parked drop only on a rebuild without the window. a
  projection change that arrives in the same rebuild as the window passes it, so
  the drop lands against rows the reader never saw.
- the parked drop is planned from inside `rebuild`, which can itself run inside
  another range's `installRange`; `plan` then re-enters the pending range layer
  mid-installation.

impact: a drop the reader thinks failed or forgot can appear later, or land after
a concurrent change. the third edge's consequence is unestablished: it may be
benign because the planner re-validates every anchor, or it may reorder pending
state. nothing is lost; the planner still refuses vanished anchors.

evidence: source reading of `outlineController.ts` (`place`, the `placing`
settlement at the end of `rebuild`); the drag fixes' own review named these as the
first place to attack. the journey that parks a drop is green (cases
`outline-drag-02-reparent`, `adversary-L2-r02-reparent`), but none fails the read,
changes the projection in the window's rebuild, or nests the settlement.

resolved when lab cases show: a parked drop whose read fails announces it and is
dropped, not replayed on retry; a projection change landing with the window voids
the drop or plans against what is shown; and a parked drop settling during
another gesture's installation leaves both gestures' order and undo intact.
