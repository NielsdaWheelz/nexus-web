# pending flat writing can consume and discard undo

external candidate `f07f1963eb` passes immediate firefox continuation through
return, indent, outdent and move, but its first undo leaves the final `s` intact
through the ten-second assertion deadline. canonical run
`20261025-235607-29c813d0cd74`, `mobile-editor-firefox.spec.ts:44` failed;
the following hint and last-unlink cases did not run.

the trace's passed text assertion immediately before undo (`cddl@130`, then
`cddl@132`) still marks the exact target field `data-outline-pending=true`.
`LocalOutline.tsx:121` skips history undo while pending input reports changed or
unconfirmed; `outlinePending.ts:73` reports changed for every raw field. the
editor consumes the key, and later settlement cannot replay it. this supports
an input-admission defect; the trace does not directly instrument that branch.

the editor owner must preserve undo in the existing ordered input owner without
dropping later writing or adding an independent queue. resolve with the same
immediate-undo journey and affected pending/structural history cases on the
integrated candidate. waiting for save before pressing undo would evade the bug.

the raw-stage repair needs canonical identity, not just delayed dispatch. for
raw `ab`, delete `b`, then receive unseen `x` before `b`: canonical yjs undo can
restore `b` with anchors depending on `x`. replaying that inverse into a frozen
raw clone lacks its dependencies; restoring the earlier body loses concurrent
writing. `commands.ts` currently creates the note's actual initializer only
after runtime store/lease admission, so immediate history cannot own it.

a new note must receive its one real initializer at semantic admission, with
creation reserved before subsequent edits. this alone is insufficient: split
and join also change existing documents. ordinary document listeners would
autosave those changes separately from their atomic structural command. the
runtime needs one bounded synchronous command admission that captures the actual
canonical yjs mutations and persists them with their graph intents. callbacks
must await only predecessor proofs captured before their own reservation, never
their own pending frontier. history must seal the actual group at admission,
rather than select the latest group after waiting. the exact api and exception
ownership remain under review; runtime code is unchanged.
