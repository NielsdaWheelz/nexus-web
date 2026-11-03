# non-range structural preparation can enter writing failure

range commands (indent, outdent, move, drop, removal) refuse before publication or
sequence allocation, preserving redo and later writing. the old selected-paste
history path and single-item movement are removed.

the remaining boundary is ordinary insertion: split, the births of return at an
item's start or end, and join, through `WritingRuntime.admitWriting`.
`preparePosition` and `preparePositions` in
`apps/web/src/lib/resourceGraph/links.ts` throw when their selected anchor is no
longer available or the position window exceeds capacity.
`attempt` and `reportFailure` in `apps/web/src/lib/notes/runtime.ts` retain the
account lease for preparation errors as well as persistence failures.

an ordinary stale-anchor refusal is therefore reported as unsaved writing and holds
later commands. this has been reproduced: in run `20261102-125144-f149a27f4224`
(case `outline-engine-13-type-fast`, chromium and firefox) a return pressed at
0 ms after an outdent anchored its birth on a row the outdent relinked;
`preparePositions` refused "unavailable" and the receipt "couldn't confirm saving
on this device" appeared. the outline now defers a return or boundary delete
until an in-flight range settles (`StructuralKeys.idle`), which closes that
schedule but not the classification: any other way an ordinary birth's anchor
vanishes before preparation still lands in the save-failure lane.

resolve in a separate non-range admission change. preserve any text already
authored by a compound command, classify expected preflight refusal explicitly,
and retain immutable retry for actual persistence failure. prove a real missing
anchor/capacity refusal leaves the prior text/history intact and later writing
unblocked.
