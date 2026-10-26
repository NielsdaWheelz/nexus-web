# full history can remove the tail entry

if the global outline session holds 64 documents through undo history, its blank
tail cannot reserve another slot. after undo removes the last visible row in an
outline without a masthead, there may be no editable field from which to request
history retirement. `outlineController.ts:append()` instead asks the user to close
a branch; an empty outline may have none. this is a source-evidenced admission
and navigation gap, not a writing-loss reproduction.

provide an explicit “write at end” action when the proven tail has no slot. route
it through the existing new-admission/history-retirement owner, retaining all
protected writing and charging documents until their actual release. prove an
empty full-history session can regain its tail without reloading or clearing
writing, and without replaying an old input gesture.

source correction adds a manual tail atom through the existing retirement owner.
run `20261026-005311-8fc1d02bd564` on `930c4a7c2` passes all 48 independently
edited and uploaded bodies, final-window paging and the actual rendered
“finishing older edits; try again” feedback. the tail remains absent for the
next 30 seconds (`outline-session-budget-tail.spec.ts:56`); the pending-copy case
does not run. this is not a writing-loss or client-capacity verdict.

`admitNew()` rebuilds after releasing documents while their references still
remain in `settlingRefs`; its finally removes those references without another
rebuild. refresh only after the existing release/charge cleanup has completed,
without replaying the first gesture. retain this issue until actual admission,
writing and order oracles pass.

the source correction publishes after that cleanup; the retry uses the unchanged
fixture and budget, with the second gesture still required to focus and write.
