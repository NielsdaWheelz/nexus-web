# a deliberate jump in a never-read article saves position 0

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

a contents/link jump in an article the user has never read saves position 0 with no reading input.

## fix

jumps are inspecting moves and must not save (pr2's navigator). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.
