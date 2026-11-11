# qualify mobile reader inspection on return

the missing-memento diagnosis is obsolete. source review at `aac38e09a` on
2026-10-28 found the visit-owned `Reader.InspectionView` in
`apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts`. it retains
viewport/navigation state by source identity; restoration precedes the durable
reading cursor. the [reader contract](../modules/reader-implementation.md)
owns that distinction.

remaining acceptance: open two passages of one media in separate mobile panes,
switch between them, and return through pane history. each must restore its own
passage and inspection decoration without changing the durable reading cursor.
a changed source must retire unresolvable view state explicitly.

these journeys remain unqualified by this record. close after observing them;
do not add a second memento or keep every mobile reader mounted.
