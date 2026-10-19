# the first click on an inactive pane's header control is lost

status (2026-10-18): deleted on main by #651 without a recorded resolution, while an uncommitted 2026-10-16 recheck (below) was still adding evidence; restored from that recheck. still open afaict: `WorkspaceHost.tsx:239` activates on pointer down and `usePaneCanvas.ts:349` centers the pane at once (harness J4/R5).

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

2026-10-16 source recheck: `apps/web/src/components/workspace/WorkspaceHost.tsx:185`
activates a pane on mouse down; its effect at `:131-134` reveals every new active
pane. `components/workspace/usePaneCanvas.ts:313-324` centers it immediately.
the same issue applies to promoted principal actions, not only menus.

prerequisite: separate active pane identity from the decision to reveal it.
fix the workspace host/canvas policy: a press inside a visible pane activates
it without moving its target; explicit strip, keyboard, or navigation activation
can request reveal. retain the clicked control's current visible position.
accept partial pane visibility after an interior press. do not replay clicks,
delay individual buttons, or add per-control propagation exceptions. any later
reveal must not disturb a newly opened anchored menu.

acceptance: one click on an inactive pane's More (or any header button) opens it, at any
canvas position; J4 opens every pane's More; search R5 opens two Reader settings panes.
