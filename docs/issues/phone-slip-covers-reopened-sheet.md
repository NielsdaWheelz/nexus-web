# phone slip and reopened sheet qualification

observed 2026-11-15 at `42618db32`, chromium 390×844 touch: after quick-note save,
reopening within the slip's eight seconds let `open` intercept a tap meant for
the lowest use-text row. the wrong pane navigated. no handset was used.

the thumb index removes that row, adds `closed {title}` / `reopen` slips and
retains the page as `MobileSheet.slipContent`. current lab qualification proves
the reopened foot's field, today, librarian and note remain hit-testable and
activate correctly with a note slip standing. it does not establish every page
line or handset behavior.

placement belongs to `components/feedback/Slips.tsx`'s `ModalAnchor`: constrained
rooms borrow the explicit scrollable content rectangle, excluding fixed controls.
reproduce with note and current-close slips, reopen immediately, and tap page
lines and the foot with few and many panes. resolve when all remain targetable
in the lab and on a handset; if reproduced, repair placement at that owner.
