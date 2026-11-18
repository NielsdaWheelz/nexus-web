# a drop onto an existing link looks like a move

the ghost names the destination parent. dropping onto a parent already linked
to the dragged note moves the existing occurrence there and removes the
source link. `OutlineController` clears the drop announcement for every
`place` plan. the ghost in `OutlineDrag.tsx` identifies the parent and mirror
mode but does not distinguish a merge. a reader can lose track of why one
fewer occurrence remains.

close when the destination preview conveys a merge before release while a
successful drag stays silent. verify with the same note under both parents.
