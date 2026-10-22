# a click's caret can return to the click point after keys moved it

status: open · origin: notes re-slice port, harness outline/O14 and outline/O2, 2026-10-21 ·
area: note bodies and editor (`components/notes/NoteEditor.tsx`)

after a click into a row's text, keys pressed at once that move or extend the caret
(Cmd-↓, Cmd-↑, Shift-←) can be undone: under a busy renderer the selection collapses
back to the click point (for a short row clicked at its middle, its end) part way
through, and the next keys act from there.

impact: a cut or delete right after a click can act on other text than the person
chose: five Shift-← over "words" then Cmd-X cut only its last two to four letters; a
Backspace meant to join a row at its start deleted its last letter ("two" → "tw").
nothing warns.

evidence: under 16 niced cpu burners (load 25 to 78), outline/O14 failed on main
`b4721d528` 2 of 28, on the re-slice before its port (`ea45e33f7`) 4 of 28 and on the
ported tip 3 of 28; unloaded, 6 of 6 passed. outline/O2 showed the "tw" form once in
20 runs on the tip at load 105. so main has it; the re-slice neither adds nor fixes it.

cause, unverified (idk): ProseMirror's state selection trails native caret moves until
the browser's selectionchange; the editor's focus handler sets react state, and a
re-render that updates the view in that window writes the stale selection back to the
dom. [the reference caret record](reference-caret-input-before-token-is-lost.md) is
the same lag in another editor.

resolved when: outline/O14 and outline/O2 pass 28 of 28 each under 16 cpu burners, or
a probe that keeps the renderer busy for 400 ms after the click shows each key acting
from where the previous one left the caret.
