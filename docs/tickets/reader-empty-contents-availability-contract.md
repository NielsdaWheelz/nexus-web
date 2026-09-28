# empty contents availability disagrees with the reader contract

status: open
origin: 2026-09-25 article-contents review, `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`
area: reader / inspector contract

`docs/modules/reader-implementation.md:340–353` describes contents as available
when toc nodes exist. `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:6404–6425`
supplies contents whenever navigation is ready, even with zero sections/nodes.
`components/resource-inspector/inspectorSurfaces.ts:82–83` publishes that body;
`components/reader/ReaderDocumentMapDetail.tsx:101` shows "no sections in this
document". these last two paths are beneath `apps/web/src/`.

the surface also contains document position/map controls, so hiding it on an
empty outline is a product decision, not an automatic bug fix. this is source
evidence only; no runtime reproduction was performed in this review.

prerequisite: decide whether contents promises an outline or the broader
document map. align the owning specification and shared publication rule for
both web articles and epubs. do not introduce an article-only count threshold.

acceptance: open documents with zero, one, and nested headings; their shared
surface availability, empty state, and initial selection match the chosen
contract, with no entries retained from the previously opened document.
