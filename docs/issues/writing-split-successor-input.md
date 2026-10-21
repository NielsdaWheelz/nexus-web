# input immediately after split misses its child editor

at `3942b8fd2`, private run `20261021-124029-3695898bc692` offline split case:
enter creates a visible second editor, but immediately inserted successor text
does not appear there. the child initially has `contenteditable=false`, then
becomes editable and focused with an empty body.

distinguish lost input from an unrealistic case interaction using the real event
trace. preserve fast typing across structural handoff at the authoring owner;
never weaken a required input guarantee by sleeping. resolved when offline
type/split/type-child/undo retains exact prose through a completed checkpoint and
restart, with no focus theft.
