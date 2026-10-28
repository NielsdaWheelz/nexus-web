# downloaded reader header during inspection

on the real samsung sm_s906w packaged shelf, selecting a nonfirst map section
produced a screenshot with the downloads/title/contents header outside the
visible frame. returning to the held place showed that header again. both source
placements and local return were correct; the cause of the framing change is
unclassified. no outer-scroll or visual-viewport measurement was captured.

evidence: local lab `20261028-111809-8bad6d2406a8`,
`artifacts/reader-map-android-nonfirst.png`,
`artifacts/reader-map-android-return.png` and the native observation json.
layout owner: `apps/web/src/shelf/{ShelfReader.tsx,shelf.module.css}`;
`lib/documentReader/text/TextSurface.tsx:127-128` already focuses with
`preventScroll: true`, so do not assume focus is the cause.

follow up with the separately scoped downloaded-phone layout work. reproduce
while measuring header bounds, document scroll and visual viewport before/after
inspection; resolve when the intended header visibility is explicit and verified
without losing the held source position.
