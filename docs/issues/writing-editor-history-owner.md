# canonical editor freezes its initial undo owner

at `d4c6d036b`, private run `20261021-132511-cd3afc4589ba`, consuming an empty
shared note succeeds, but undo in the retained parent sends no inverse and leaves
one child. `NoteEditor.tsx` chooses domain history or local prosemirror history
once during view construction. canonical editors initially lack their local
draft handle, so the captured history is null; readiness later changes the
current owner but the keymap permanently keeps local undo/redo.

choose the current history owner when each command runs, retaining editability
and composition gates. resolved when the retained shared-note inverse restores
the canonical note through a fresh link without recreating the editor or waiting
for an arbitrary delay, and its subsequent edit reaches that canonical body.
