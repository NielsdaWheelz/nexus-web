# imports pane remains an operator console

origin: 2026-11-01 import survey at `61562d1`
status: deferred by the owner on 2026-11-01; outside the import rebuild

at `aed29154`, `apps/web/src/components/imports/ImportsToolbar.tsx:125` still presents structured filters and refresh; `lib/imports/query.ts:47` retains attention, progress and history modes. `components/imports/ImportRow.tsx:54` makes the title select the inspector. the reader must still distinguish work readiness from pipeline and history controls.

the survey's seven-control/92-radio counts and narrow-layout screenshots are historical, not a new census. the accepted rebuild leaves this pane deferred and accepts that `see why` lands here.

a separate redesign may use one newest-first list, title-to-work activation and a conditional attention filter. deleting stage/date filters would remove existing query capabilities and change the pane contract; that cost needs its own owner decision. resolve through that separately scoped redesign or an explicit owner closure. carrying this record neither approves nor implements it.
