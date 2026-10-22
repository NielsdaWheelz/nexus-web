# native preferences send while unavailable

`apps/web/src/lib/player/nativeEngine.ts`, `preference`, checks the loaded key
and subject but omits the `responding` admission guard used by `keyed`. after
one settings command times out, a newer queued preference flight can still post
to the unavailable transport. preserve its captured intent without issuing an
implicit new command after known transport loss.

the silence implementation owner is qualifying this with genuine frame delivery
withheld, then repairing the existing preference boundary. no second load fence
or lifecycle is needed. the player's receipt-retention case does not prove this
queued-flight behavior.

resolved when real timeout/queued-choice qualification rejects the later send
while unavailable, retains truthful failure and permits explicit retry after
recovery on the same subject.
