# spoken pane-list qualification

actual screen-reader output remains unverified. accessible-name, focus and grid
checks cannot establish spoken order, interruption or announcement timing.

the owners are `apps/web/src/components/nexus/NexusPaneList.tsx` and
`useNexusPaneReorder.ts`, desktop's combobox/grid and mobile's native buttons.
the source, current pane and destination are separate facts. the thumb index's
`earlier` recovery is inside the grid; marked lines say `closed. activate to
keep it open`. reorder is drag-only with no keyboard or screen-reader path.

resolve with a desktop screen reader and android talkback: duplicate and long
titles; moved/no-op/cancel announcements; mark/unmark and refused close focus;
folded recovery; echo description; double-tap-and-hold to fork. confirm the
query name stays stable and decorative drag content is silent.
