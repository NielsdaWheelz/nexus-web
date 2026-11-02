# margin placement observers miss replaced rows

problem: the margin's placement effect observes each mounted row, but a local row
replaces its `li` after first render, so its observer stays on the detached node.

impact: a local row that grows after that swap does not reschedule placement. it
can overlap the row below it until the reader moves the text or another dependency
of the effect changes. rows and drafts are unaffected.

evidence: source review on branch `reader-margin`, not reproduced in a browser.
`apps/web/src/components/resources/ResourceOutlineRow.tsx:150-152` swaps
`Occurrence` for `AuthoredRow`, and
`apps/web/src/app/(authenticated)/media/[id]/evidence/EvidencePane.tsx:343` binds
observers only when the effect reruns. no dependency of that effect changes on the
swap. the same stale nodes broke restoration, which now looks rows up live and
observes the list root. aligned rows are absolute, so a root observer cannot see
their growth here.

proposed fix: observe placed rows through a callback ref at the row, so the observer
follows the `li` that exists.

resolved when a local margin row that grows after mount pushes the row below it
without the reader moving the text.
