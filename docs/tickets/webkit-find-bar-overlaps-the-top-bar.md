# on webkit the mobile find bar rides 3px into the top bar

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / find, pane shell css

with Find open in a mobile media pane (390x844, More → Find), the contextual row
(`PaneShell`'s `.chrome`) starts at y=60, directly under the 60px top bar, on
both engines. inside it the find bar (`Find.module.css` `.bar` →
`PaneToolbar` `.toolbar` → `.search` → the input) sits at y=62 on chromium but
y=57 on webkit, 3px above its own row and over the top bar's bottom edge; the
webkit row also shows a horizontal scrollbar under the input. measured on the
rewrite (probe, 2026-10-10): row `[0,60,390,48]`; find bar chromium
`[8,62,374,44]`, webkit `[8,57,374,44]`. the chrome motion is not involved (the
row is Pinned while find is open); this is layout inside the 48px contextual
frame.

what to do: find the webkit-only vertical offset in the find bar's flex/scroll
container (likely the horizontally scrolling toolbar's alignment or its
scrollbar gutter inside the fixed 48px frame) in `Find.module.css`,
`PaneToolbar.module.css` or `PaneShell.module.css`, and make the bar sit inside
its row on both engines.

resolved when: on webkit and chromium the find bar's box lies within the
contextual row's box at 390x844.
