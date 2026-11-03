# non-range structural preparation can enter writing failure

priority: deferred non-range admission work unless the focused correctness probes reproduce a current ordinary-use trigger. preserve authored text and immutable persistence retry; do not redesign admission from a speculative schedule.

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
on this device" appeared. births now bind canonical writing immediately and
prepare their placement from the preceding arrangement's resolved parent and
anchors; boundary deletion refuses while that arrangement is unresolved. this
closes the reproduced schedule without changing failure classification: another
way an ordinary birth's anchor vanishes before preparation could still enter the
save-failure lane. no remaining ordinary-use trigger has been demonstrated.

resolve in a separate non-range admission change. preserve any text already
authored by a compound command, classify expected preflight refusal explicitly,
and retain immutable retry for actual persistence failure. prove a real missing
anchor/capacity refusal leaves the prior text/history intact and later writing
unblocked.
