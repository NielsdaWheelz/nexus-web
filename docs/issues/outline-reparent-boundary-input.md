# structural input during atomic arrangement

an in-flight indent/outdent keeps the existing note or title bound in
`OutlineLiveInput.tsx` until its destination occurrence is ready. ordinary typing,
character deletion and return continue through that handoff. structural boundary
join/removal is unavailable during this atomic arrangement; the bridge has no
boundary callbacks, and `LocalOutline.tsx` refuses a pending boundary plan across
an unfinished parent handoff. other arrangement controls and undo/redo are also
unavailable while the admitted arrangement finishes.

move up/down keeps the existing occurrence mounted, but its atomic admission
guard also refuses return until the move completes (`arrange`'s move branch and
`startSplit` in `LocalOutline.tsx`). following typing stays in the existing block.
this overlap is source-evidenced and has not yet been qualified with native
events. indent/outdent's live bridge does retain return.

reproduce by indenting/outdenting a focused note and immediately pressing
backspace at its start, delete at its end, or deletion while empty before the
new occurrence is ready. the structural deletion is refused; ordinary writing
continues in the same shared document. this is an explicit prototype limit,
not full native-editor parity.

resolution needs proven destination neighbors captured with the arrangement and
retained input intent, using the existing read/input owners. an indent can target
a collapsed, unloaded branch; neither its neighbors nor absence may be guessed.
prove immediate arrangement plus boundary input, following writing, repeat and
undo order without a second graph mirror or another native-edit interpreter.
