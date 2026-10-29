# spoken pane-list qualification

actual screen-reader output remains unverified. accessible-name, focus and grid
checks cannot establish spoken order, interruption or announcement timing.

the owners are `apps/web/src/components/nexus/NexusPaneList.tsx` and
`useNexusPaneReorder.ts`, desktop's combobox/grid and mobile's native buttons.
the source, current pane and destination are separate facts; recovery uses native
tab stops outside candidates.

resolve with a desktop screen reader and android talkback: duplicate and long
titles; source/destination selection; moved/no-op/cancel announcements; refused
close focus; inline recovery. confirm the query name stays stable and decorative
drag content is silent.
