# deletion coverage can absorb an unrelated same-device touch

`lib/notes/structure.ts::cover` extends structural inverse coverage with later
receipts owned by that history. a replica counter is a prefix, not an isolated
event: creation at 1, another outline session's edit at 4, then this history's
edit at 5 lets its inverse cover 4 too. undoing creation can therefore hide
independent writing. link-add coverage has the same prefix constraint. this is
a reproduced defect: on `b1b09675f`, live run
`20261025-210327-5107f3e65a96` passes both same-replica actor clocks and
first text undo (`ABC` → `AB`), then creation undo leaves canonical `AB` hidden.
the creation link is removed and the unrelated resource/link remain unchanged.

touch-only predecessor certification also blocks legitimate redo: another
session edits and deletes through 4; this history undoes its hidden creation,
then redoes it with restore 5. refusing coverage 5 merely because the old touch
was 4 makes the next undo ineffective. the exact pre-commit deletion/removal
vector must distinguish already removed predecessors from independently live
ones; removals made by the command itself cannot authorize its coverage.

the incoming flat-editor candidate checks full yjs state before extending a
displayed field's coverage. that includes text deletion sets, but not touch-only
`restore_resource` events. body equality alone cannot prove observation of every
intervening resource touch. preserve the resource's causal contract rather than
silently narrowing it to differing text bytes.

resolve at the shared capture/receipt/history boundary: only extend a replica
prefix when every intervening relevant touch is covered. retain the last safe
coverage otherwise. qualify another same-device session's intervening edit and
restore, subsequent local typing, explicit delete/join and structural undo;
independent writing and links must survive. no event ledger, storage migration or
private runtime test seam is implied.
