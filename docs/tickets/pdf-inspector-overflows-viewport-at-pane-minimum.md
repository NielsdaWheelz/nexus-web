# pdf inspector overflows the viewport at the pane minimum

status: open; pre-existing · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: workspace geometry

desktop 1440x900, a pdf pane at its 834px minimum with the inspector open: the
secondary region extends past the viewport; the panel close control spans
x=1446..1474 before any focus and its centre misses hit testing. a wider stored
pane pushes it further (880px -> 1520, 954px -> 1594). tab focus scrolls the
pane canvas and brings it to 1400..1428, so it is keyboard reachable only.

fix: the pane canvas budget must fit primary minimum + fixed chrome + secondary
width, or the secondary must yield, so the attached panel is fully visible.

acceptance: at 1440x900 with a pdf at its minimum width, the open inspector and
its close control are within the viewport and pointer-reachable.
