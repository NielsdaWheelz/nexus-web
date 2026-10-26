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

source correction is implemented: a manual tail atom requests the existing
history/document retirement path before admitting an editable field. the focused
64-note paging/history/tail case remains unexecuted; retain this issue until its
actual admission, writing and order oracles pass.
