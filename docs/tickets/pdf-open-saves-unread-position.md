# opening a pdf saves a reading position with nothing read

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

within ~2 s of opening, the hosted pdf reader writes page 1 to the server, turning an empty cursor into a saved one with no reading input. the web article reader does not do this. pinned as xfail `R.P.J2.open-does-not-save` in the reader harness.

## fix

save only on reading movement (pr2's shared reader already does: opening writes nothing). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.
