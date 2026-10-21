# structural storage failure releases pending history

`apps/web/src/lib/notes/useOutlineSession.ts` called its terminal refusal callback
from both admission durability and settlement. a failed local transaction leaves
the journal admission pending for storage retry; premature refusal rolled back its
projection and released deletion-history protection even though retry could later
commit and receive an acknowledgement. a definitive admission refusal could also
invoke the callback twice.

the real quota case in lab 8 reached the terminal refusal after the failed local
transaction: `writing-recovery.spec.ts:622` expected `that change couldn’t be saved`
to remain absent, but the old durability callback displayed it.

implemented: settlement alone owns terminal rollback; a durability failure only
republishes the journal's existing storage status. awaiting the green run. resolved
when the same quota case preserves its projection and prose, storage retry commits
it, and undo still sends the correct inverse after acknowledgement.
