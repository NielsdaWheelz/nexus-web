# observed-delete coverage needs final qualification

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

the runtime now carries exact per-identity pre-cas certificates and the shared
`advanceCoverage` helper checks removed as well as covered predecessors. the
incoming flat editor uses those certificates; yjs inclusion is additional byte
protection, never a substitute for touch-only restore/no-op causality.

resolve at the shared capture/receipt/history boundary: only extend a replica
prefix when every intervening relevant touch is covered. retain the last safe
coverage otherwise. qualify another same-device session's intervening edit and
restore, subsequent local typing, explicit delete/join and structural undo;
independent writing and links must survive. no event ledger, storage migration or
private runtime test seam is implied.

removed-resource predecessor baseline control passes on `b1b09675f`, run
`20261025-222224-0e2a5f7ffee4`: two actual same-replica sessions, a full foreign
edit and public resource deletion, then creation undo/redo/undo preserve exact
text and expected visibility, coverage, ordinary relation and unrelated rows.
this validates the control fixture before qualifying the guarded candidate; it
does not exercise a higher foreign link-add removal.

the guarded flat candidate passes both unchanged public-ui cases in run
`20261026-010502-eca4d6fd6006` on `482d5d119` (product `413043e4f`, runtime
`2453d1a36`). case 40 preserves foreign `B` through own text and creation undo:
canonical `AB` remains visible while the creation scope is unlinked. case 41
passes the removed-resource predecessor control. both prove one same-replica
actor clock and unchanged unrelated rows. the compound-admission/history change
must retain these results. current runtime `1dac` passes both unchanged cases
on root `5722c445d`, run `20261026-065625-f4aa9c71beee`.

root `9cefc062e`, run `20261026-070702-86fd5a46dbe9`, also passes the actual
same-replica foreign-link control: after another history re-adds the pair, own
redo and fresh unlink upload, but removal retains the earlier certified prefix
below the foreign add. the foreign membership survives. ordinary empty-note
unlink after undo and held birth/undo/redo/fresh unlink pass too. these cover
the repaired pending relationship handoff; explicit joins, touch-only restores
and observing an already-existing target relationship remain separate final
qualification obligations, not reproduced failures of the current source.
