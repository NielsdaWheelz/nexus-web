# fresh unlink observes the link before redo

real held-ui run `20261026-055946-79f6169585d5`, source `c19992566`, creates
a note, undoes creation, redoes it, then selects and unlinks it before any
receipt. the server feed proves four commands from one replica, with the final
unlink after resource touch 3. the final link is `add={r:3}, remove={r:1}` and
remains visible; its note body, liveness and untouched control are correct.
this is an observed-membership failure, not upload delay or writing loss.

history advances owned inverse coverage, but the pending occurrence still gives
new gestures its birth-link promise. revision-only acknowledgement cannot repair
a proof already frozen by the next gesture. install the eventual relationship
proof synchronously at semantic admission in the existing bound owner; fold only
actual before certificates through shared `advanceCoverage`. preserve the current
proof through same-parent scalar history. never substitute the latest broad
state, force removal, or await the promise being installed.

the receipt can contain several patches for one link; fold every matching patch
against that identity's actual before certificate. a missing certificate retains
the lower proof. start new-link coverage empty and fold the actual certificate;
an empty before-state requires certified absence. never seed coverage from an
unguarded add patch.

`outlinePending.resume()` retires the bound entry, and `occurrence()` then falls
back to `fields[row_id].link`. install the guarded future through the existing
relationship owner so its resolved proof also reaches that field before
settlement; updating only `Bound.link` leaves a second stale-proof path. retain
the existing promise-identity and receipt-owner guards against older completions.
superseded callbacks still resolve their proof for successor chains; the guards
reject stale publication, not that value. offscreen settlement needs no mounted
input owner.

resolve with the unchanged lock-held ui control and preservation of unseen
foreign additions. keep runtime, schema, queue and registry ownership unchanged.
