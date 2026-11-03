# outline: a deferred return or boundary delete replays after characters typed meanwhile

## problem

while a range gesture (indent, outdent, move, place) is in flight the shown rows trail it, so a return or a
boundary backspace/delete pressed in that window now waits for the gesture to settle and replays against the
settled rows (`NoteEditor.tsx` `structuralInput`, `StructuralKeys.idle`, `OutlinePendingInput.idle`). characters
typed inside that window enter the field natively at once; the replayed return then splits at the caret as it
stands, so those characters land before the split rather than after it.

## impact

a burst like `c`, shift+tab, return, `d` with no pause between the last two can read `cd` then an empty row
instead of `c` and `d`. the window is the gesture's local commit, milliseconds on a healthy store; a store that
cannot confirm saving holds the key until retry.

## evidence

run `20261102-125144-f149a27f4224` (before the deferral): the return at 0 ms birthed against the trailing rows,
the birth's anchor had been relinked by the gesture, `preparePositions` refused "unavailable" and the receipt
"couldn't confirm saving on this device" appeared (`outline-engine-13-type-fast`). run
`20261102-134659-69d8dcd1a44c` (after): the case passes on chromium and firefox because it waits for the caret
before typing; it does not exercise characters typed inside the window.

## resolved when

a case types `c`, shift+tab, return, `d` with no waits and the settled outline reads `c` then `d`; either the
birth is provisional and admitted after its anchor settles, or keystrokes after a deferred structural key are
queued behind it.
