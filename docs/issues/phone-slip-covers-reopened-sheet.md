# a standing slip intercepted a reopened phone sheet

historical lab evidence: touch-emulated chromium, 390×844, `42618db32` on
2026-11-15; not observed on a handset. saving a quick note closed the sheet and
left the eight-second `added to today` slip. reopening before it expired put
its `open` action over the lowest row; a tap intended for that row opened today.

impact: a sheet action unexpectedly navigated the underlying pane.

the thumb-index footer has since changed. the overlap has not been requalified;
its persistence is not established. the current owner is
`apps/web/src/components/switchboard/SwitchboardTask.tsx` `slipContent`, passed
to `MobileSheet`, together with the shared slip placement owner.

reproduce with the current note action, reopen while its slip remains, then
hit-test the lowest row and footer. resolved when a standing slip cannot take
those taps, including on the handset; choose yielding or non-overlapping
placement at the shared sheet/slip boundary.
