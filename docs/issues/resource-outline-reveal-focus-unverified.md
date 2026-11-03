# outline return focus under an href-less ancestor is unverified

`ResourceOutlineList.tsx` now focuses a mounted occurrence's bullet, or the
named row when its bullet is disabled; windowed-out occurrences delegate reveal
to the host. disclosure removal shares that target through `outlineRowFocusTarget`.
the density lab does not drive return under an ancestor without an href or this
disabled-bullet path. source review alone qualifies the change.

impact: the new row anatomy changes the focus target from the leading chevron
to the bullet/row without a live journey for this edge.

resolved when: nested terminal return and focused-disclosure removal keep named
focus under an href-less ancestor, including a windowed-out target admitted by
its host.
