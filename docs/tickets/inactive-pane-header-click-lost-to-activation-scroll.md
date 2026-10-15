# the first click on an inactive pane's header control is lost

status: open
origin: 2026-10-14 cleanup stack replay onto main 367da80e0 (host harness J4); cause in
main #614 (`usePaneCanvas.ts` `scrollPaneIntoView`, now `behavior: "instant"`)
area: web / workspace canvas

pointer down on an inactive pane activates it, and activation scrolls that pane into view.
#614 made the scroll instant (it was smooth), so a pane that is not already centred jumps
between pointerdown and pointerup: the control under the pointer moves 155–460 px and the
click lands elsewhere. pressing an inactive pane's More opens nothing; the pane only
becomes active.

evidence: host harness J4.header-per-pane-kind (`2026-10-14/replay2/runs/tip1-host.txt`):
Shelf 01's More never opened a menu. probe (`2026-10-14/replay2/probe/j4c.mjs`): Shelf 01
More at x 904 before pointerdown, x 1059 200 ms after; Nightjar 904 -> 1085; the active
Libraries pane's More did not move and opened. search harness R5.two-reader-settings-panes
(`2026-10-14/replay2/runs/g2-tip2-search.txt`): after the media pane's first Reader settings
opens beside it, the media pane's More times out; probe (`2026-10-14/replay2/probe/r5.mjs`):
More at x 804 before pointerdown, x 1263 200 ms after, no menu; the now-active pane's More
did not move and opened.

what to do: do not move a pane under a press that activates it (scroll after the click
settles, or only when the pane is outside the viewport), or treat the activating press's
click as landing on its original target.

acceptance: one click on an inactive pane's More (or any header button) opens it, at any
canvas position; J4 opens every pane's More; search R5 opens two Reader settings panes.
