# a range gesture that revives a removed link does not give its place back on undo

problem: one link per pair means a drop, mirror or move onto a parent whose pair
was once linked and since removed revives that link (`OutlineHistory.range`'s
`relink`/`mirror` arms in `apps/web/src/lib/notes/structure.ts` lower `add_link`
for the destination id with fresh positions). its inverse is `unlink` alone, so
the positions it wrote stay on the invisible link. undoing the earlier removal
then lowers `restore_link`, which keeps those positions: the item comes back
where the later gesture put it, not where it was.

impact: undo after a remove-then-drop onto the same parent restores the order
wrong. nothing is lost; the order needs fixing by hand.

evidence: the same defect in paste, run `20261102-130720-5089a92f68a7` (case
`outline-clipboard-01-cut-paste`: cut b, c, d; paste back under the page; three
undos returned them after e). fixed there in `createMany`, which now reads the
revived link's prior state and lowers `restore_position` beside its `unlink`
(green in run `20261102-131720-1ff804586365`). the range arms are not changed
and not cased.

proposed fix: in `range`'s prepare, read the destination id's state when it is
not visible; when it exists, push its positions into `previous` so the existing
`restore_position` inverse and replay put them back.

resolved when: a lab case removes an item from a parent, drops a mirror of it
onto that parent, undoes twice, and sees the item at its original place.
