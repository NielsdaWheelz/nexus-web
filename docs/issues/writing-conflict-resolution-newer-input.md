# conflict resolution clears a newer revision's conflict

at `d90ed1033`, `journal.ts:638–644` adopts an older saved snapshot while preserving a newer owned value, revision and selection, but replaces the newer conflict. `resolveDraftConflict` calls it with `conflict: null` after its indexeddb transaction (`journal.ts:1948`).

a commit during that transaction stages a newer revision with the existing conflict. adoption then clears its conflict; `refreshJournal` publishes this before the queued checkpoint restores it. a second edit in that interval passes `texts.ts`'s `intentFor` conflict guard and can admit an autosave without a decision on that newer writing. this interleaving is source-confirmed; it has not been reproduced live.

preserve the conflict belonging to a newer owned revision when adopting the older resolution. resolved when two commits around a held conflict-decision transaction keep the newer prose conflicted and admit no automatic write.
