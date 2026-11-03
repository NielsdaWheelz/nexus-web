# pasting a non-authored reference relies on an existing source stub

problem: paste by reference links every copied ref through
`OutlineHistory.createMany` (`apps/web/src/lib/notes/structure.ts`), which lowers
`add_link` alone. `prepareLink` (`apps/web/src/lib/resourceGraph/links.ts`) also
emits `capture_source` for endpoints outside `note_block|page|highlight` that have
no source stub. a copied media, conversation or other foreign reference row was
linked once, so its stub normally exists; whether a stub survives every unlink and
sync path is not established.

impact: if a stub is missing, the pasted link may lack its source label or be
refused by a host that requires the stub. unobserved.

evidence: `createMany`'s prepare emits positions, moves and `add_link` only; the
build's lab cases paste notes, never a foreign reference.

proposed fix: carry the copied label into the birth and emit `capture_source` the
way `prepareLink` does when `readStates({source_refs})` finds no stub.

resolved when: a lab case copies a media reference row, cuts it, pastes it under
another note, syncs, and observes the link and its label on a second replica.
