# every open branch reserves a write row

priority: deferred design follow-up; not a release gate. prefer one empty root entry, preserving nested entries while they hold writing. change the controller only when revisiting density, with return/removal/paste still reaching each branch.

problem: each open parent ends with its own tail row, a full-height "write or @ to
link" field (`outlineController.ts`, the tail rows `rebuild` emits per open
window). a page with five open branches shows five empty write rows between its
items. the outline prototype the redesign was approved from shows none: nested
writing starts from return at the end of a parent, which now births its first
child, so the nested tail rows reserve space for an entry that return already
provides.

impact: open branches read looser than the 25px/32px row rhythm suggests, and the
outline shows chrome for a fact that is not true now (an empty item), against the
redesign's own goal that nothing is reserved for such facts.

evidence: the presentation lane's screenshots (lab run
`20261102-124325-a5fea5533d28`, `anatomy-*` shots) and its report; the
controller emits the rows, so css alone cannot remove them without hiding a live
input.

needs an owner decision: keep nested tail rows, keep only the root's, or show a
nested tail only while it holds writing. removing them touches the controller's
row emission, the caret targets of removal and the placeholder contract in
`docs/modules/notes.md` ("reserved blank inputs").

resolved when the owner decides and an outline with open branches shows the
decided rows, with return, removal and paste still reaching every branch.
