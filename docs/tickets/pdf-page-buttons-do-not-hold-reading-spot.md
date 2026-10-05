# pdf page buttons jump without holding the reading spot

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

the hosted pdf page buttons move and save progress at once, with no "reading spot held" status; the spec lists them as deliberate jumps that hold, and an internal pdf link does hold. pinned as xfail `R.P.J4.page-buttons-hold-spot`.

## fix

route page buttons through the navigator as inspecting jumps (pr2). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.
