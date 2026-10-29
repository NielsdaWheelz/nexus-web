# non-range structural preparation can enter writing failure

range commands now refuse before publication or sequence allocation, preserving
redo and later writing. the old selected-paste history path is removed.

the remaining boundary is ordinary insertion and single-item movement through
`WritingRuntime.admitWriting`. `preparePosition` in
`apps/web/src/lib/resourceGraph/links.ts` throws when its selected anchor is no
longer available or the position window exceeds capacity. `attempt` and
`reportFailure` in `apps/web/src/lib/notes/runtime.ts` retain the account lease
for preparation errors as well as persistence failures.

an ordinary stale-position refusal can therefore be reported as unsaved writing
and hold later commands. this is a source finding; that non-range schedule has
not been reproduced. range preflight qualification does not establish it safe.

resolve in a separate non-range admission change. preserve any text already
authored by a compound command, classify expected preflight refusal explicitly,
and retain immutable retry for actual persistence failure. prove a real missing
anchor/capacity refusal leaves the prior text/history intact and later writing
unblocked. the range slice does not replace text/split/join history.
