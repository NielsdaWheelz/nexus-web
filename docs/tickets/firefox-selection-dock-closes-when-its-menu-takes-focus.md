# on firefox the selection dock closes when its More menu takes focus

status: open · origin: 2026-10-10 overlay kernel reauthor (cleanup/overlay-kernel-reauthor), overlay harness D9 · area: web / reader

opening the selection dock's More menu moves focus to the menu's first item
(the menu pattern). firefox collapses the document selection when that button
takes focus (probed: `selectionchange` with a collapsed selection right after
`focusin` on the item; chromium and webkit keep the selection). the reader's
text surface then reports a null capture and the dock, which lives exactly as
long as the capture, closes with its menu still open over nothing.

impact: firefox only. the dock's More menu (Learn, Ask in existing chat…,
Share) loses its context the moment it opens; one Escape leaves neither menu
nor dock (`J5.selection-dock-menu-then-dock@firefox`,
`O10.light-dismiss-dock@firefox` stay xfail).

what to do: keep the reader's capture while focus moves into the dock's own
controls (the capture owner, `lib/documentReader/text/TextSurface.tsx`, can
ignore a collapse whose new focus is inside the dock), or restore the range
when the menu closes. the overlay stack is not involved: Escape closes one
layer on every engine.

resolved when: both journeys pass on firefox without xfail.
