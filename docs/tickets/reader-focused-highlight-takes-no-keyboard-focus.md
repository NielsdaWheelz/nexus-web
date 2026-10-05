# a focused highlight no longer takes keyboard focus

status: open · origin: 2026-10-05 reader rewrite pr2 · area: web reader / accessibility

pr1 painted marks as `<mark>` elements and focused the shared or deep-linked
highlight (`tabIndex = -1`, `focus({preventScroll})`), so a keyboard or screen
reader user arrived on the passage. pr2 paints with css custom highlights (owner
decision r4): a focused mark is an `hl-focus` underline with no element, and
nothing takes focus. the public share (`/s`) and hosted deep links
(`#highlight-<id>`) open with the passage in view and underlined, but focus stays
on the reading area and nothing is announced. the harness check `S.J15.*`
"focused" now observes the underline, not dom focus.

fix: on an arrival (not on hover or click), focus the block that contains the
focused mark's start with `tabindex="-1"` and `preventScroll`, or announce the
passage in the reader's live region.

acceptance: opening a public share or a highlight deep link puts keyboard focus
(or a screen-reader announcement) on the shared passage without moving it.
