# structural storage failure releases pending history

`apps/web/src/lib/notes/useOutlineSession.ts` called its terminal refusal callback
from both admission durability and settlement. a failed local transaction leaves
the journal admission pending for storage retry; premature refusal rolled back its
projection and released deletion-history protection even though retry could later
commit and receive an acknowledgement. a definitive admission refusal could also
invoke the callback twice.

settlement must own terminal rollback; a durability failure only republishes the
journal's existing storage status. resolved when a real quota failure during a
structural edit preserves its projection and prose, storage retry commits it, and
undo still sends the correct inverse after acknowledgement.
