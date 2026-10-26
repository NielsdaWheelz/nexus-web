# structural input during atomic arrangement

the prior mounted-field handoff refused structural boundary deletion during
indent/outdent and return during move up/down. its temporary input bridge could
not provide the destination's exact neighbors.

the replacement `outlineController.ts` keeps one host and occurrence, queues
return through `outlinePending.ts`, and resolves the intended placement inside
the existing history command owner. joins use only proven adjacent rows from
`useOutlineWindow.ts`; an unloaded destination must not imply a missing neighbor.
the replacement remains unqualified for immediate arrangement plus boundary input.

reproduce by indenting/outdenting a focused note and immediately pressing
backspace at its start, delete at its end, or deletion while empty before the
new placement is acknowledged. check the displayed and canonical writing, caret,
relationship and undo order. repeat with an initially collapsed destination and
an off-window neighbor.

resolution needs proven destination neighbors captured with the arrangement and
retained input intent, using the existing read/input owners. an indent can target
a collapsed, unloaded branch; neither its neighbors nor absence may be guessed.
prove immediate arrangement plus boundary input, following writing, repeat and
undo order without a second graph mirror or another native-edit interpreter.
