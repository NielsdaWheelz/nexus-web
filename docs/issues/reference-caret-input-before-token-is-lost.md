# input right after Home in a reference caret can land before the token and vanish

status: open · origin: notes re-slice harness (consumers/B1d), 2026-10-21 · area: notes
outline (`components/notes/ReferenceRowEditor.tsx`)

Home, or a focus or click at the caret's start, leaves the browser's caret before the
reference token. the editor moves it after the token only once the browser reports
the move (selectionchange). when the renderer is busy, the next key or composition
runs first, lands before the token, where the editor reads nothing, and is dropped
without a write.

impact: a character typed or a word composed right after Home in a reference row can
be lost without notice.

evidence: the notes harness journey consumers/B1d fails on main `c69ba7cba` and on
the re-slice, though not on every run. a probe that queues a 400 ms task on Home's
keydown reproduced it every time, for a typed key and for a composition. overlay/O-4
(focus a reader passage's "continue under" caret, End, type a line) loses the whole
line the same way under 16 niced cpu burners: main `b4721d528` 4 of 24 (load 68 to
105), the re-slice before its port (`ea45e33f7`) 8 of 24 (load 83 to 160), the
ported tip 2 of 12 (load 50) and once in a full harness cycle.

a candidate fix was tried and not merged (outside the re-slice's mandate): move such
a caret after the token on focus, keydown and keyup. it fixed every probe variant,
but it moves only the dom caret, so a key command that reads ProseMirror's state
selection before the next selectionchange may still act at the stale position.

resolved when: with the renderer held busy, a typed key, a composition, a paste and
a key command (enter, backspace) right after Home in a reference caret each act after
the token.
