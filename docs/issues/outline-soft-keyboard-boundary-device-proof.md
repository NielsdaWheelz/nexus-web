# soft-keyboard boundary deletion needs device proof

priority: deferred to the next android apk, before regular phone editing.

`NoteEditor.tsx` now fences keyless deletion packets to their initial field.
without release identity, a caret tap or another edit re-arms boundary deletion;
a pause does not. hardware keyup retains normal press/release behavior.

the browser probe exercises cancelable `beforeinput` packets and ime-style
keydown 229. it does not establish gboard's actual composition, cancellation or
release behavior. a native path that bypasses that contract could cross rows.

resolve on the paired apk: hold backspace to empty a disposable item, verify it
stops there and preserves the item above, tap the caret and delete across the
boundary once, then verify undo and caret placement. repeat after switching away
and returning. use the existing [android journey](outline-android-touch-journey-unproven.md)
and its recorded attachment blocker; no broader keyboard matrix is required.
