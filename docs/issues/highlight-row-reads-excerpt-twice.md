# highlight rows outside the source repeat excerpt reads

status: open; remaining paths established by source review.

reader connections passes placed highlight projections to `ResourceOutlineRow` and
`HighlightAnnotation`; neither owns a per-row excerpt/resource subscription there.
clipped captures are filled once by `lib/documentReader/annotations.ts`.

outside that held path, `components/resources/ResourceOutlineRow.tsx:LocalRow`
can query `{kind:"excerpt"}` when it has a reading ref. its `AuthoredRow` then
renders `FullResourceBody`, whose `ExcerptDisclosure.tsx:useFullExcerpt` queries
the same excerpt. it can also read the source label. `HighlightAnnotation`'s
former resource query is deleted. store-side subscription deduplication has not
been measured. remote passage bodies still read the full server item.

impact: avoidable per-row work on unplaced highlights and other workspace surfaces,
especially contained readings whose excerpt query pages intervals and quote windows.
`OutlineEditorRow` also needs full bodies, so removing disclosure's query globally
would discard its ownership contract.

resolved when the host supplies the already-proved full excerpt where it has one,
and representative mounted rows issue one excerpt read, with failures and capture
revision checks preserved.
