# qualify timed connection placement

the original document-start fallback is repaired. source review at `0f7d6ffa6`
on 2026-10-28 found that
`apps/web/src/app/(authenticated)/media/[id]/evidence/model.ts` projects a
time extent into intersecting transcript units and returns null when none
exists. the [reader contract](../modules/reader-implementation.md) preserves
unavailable placement rather than inventing document-start geometry.

remaining acceptance: connections at distinct transcript times follow and mark
their respective passages while scrolling; an uncovered time remains explicitly
unplaceable. verify current following/alignment presentation, not the removed
always-zero branch. that rendered journey was not run in the source review or
this cleanup; close after it is observed.
