# library row-removal focus contract is unimplemented

status: open · origin: 2026-10-04 presentation audit, main `c6eef81c9` · area: web / library focus

`LibraryPaneBody.tsx:368–369` promises next filtered row, previous row, then
pane search after removal of the focused row. the actual pane only establishes
`listRegionRef`; its focus calls at `:976–991,2124–2153,2204–2269` serve refresh
failure, retry and filter recovery. `CollectionView`, `CollectionRow` and
`ResourceRow` do not provide the promised traversal. source-qualified gap,
not a reproduced runtime failure or an invariant proved by the comment.

clarify the required removal-focus policy and implement it at the responsible
collection/presentation owner if retained. preserve the separate real slate
terminal/add handoff in `ReadingSlateSection.tsx:174–205,289–314` and existing
retry/recovery focus. this is outside the entry snapshot-owner slice.

done when the comment accurately names the implemented contract and actual
focused-row removal demonstrates its next/previous/search decisions without
stealing focus after a deliberate move elsewhere.
