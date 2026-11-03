# immediate birth, undo, redo and arrangement need causal proof

priority: deferred rare input sequence; no failing browser journey establishes
the consequence. ordinary immediate birth/undo/redo and queued arrangements have
separate proof.

`OutlinePendingInput.followBirth` retains a birth's placement future in
`bound.next`. non-range history `acknowledge` advances `bound.link`, while
`range`'s `pin` prefers `bound.next`. if a birth is undone, redone and arranged
before those receipts settle, the arrangement could retain the original birth's
membership witness instead of the redo's. fresh positional reads establish
order, not authority to remove a newer membership.

impact is unproven: the gesture might refuse or leave a restored source relation
visible. do not replace the pinned witness with live membership as a shortcut;
that could claim an independent add. the owner is
`apps/web/src/lib/notes/outlinePending.ts` and non-range replay admission in
`apps/web/src/lib/notes/structure.ts`.

resolve with one real browser/store journey admitting birth, undo, redo and
arrangement before settlement. verify the intended parent, exact memberships,
later typing and subsequent undo. if it fails, make the later admitted replay own
the placement/witness future without changing earlier commands' captured proofs.
