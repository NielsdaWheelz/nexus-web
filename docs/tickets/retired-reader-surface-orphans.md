# orphans left by the reader retirement: dead symbols, dead error codes, dead helper

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: hard-cut cleanliness

## what is wrong

the epub/whole-document retirement left surface behind that no path reaches. each
item was verified against the current tree:

- `python/nexus/errors.py`: `E_CHAPTER_NOT_FOUND` (lines 157, 358) and
  `E_EPUB_FIND_SOURCE_CHANGED` (lines 159, 360) have no producer anywhere in
  python — their only raise sites were `epub_read.get_epub_section_for_viewer`
  and `epub_find.find_epub_for_viewer`, both deleted. the matching
  `E_CHAPTER_NOT_FOUND` arm in
  `apps/web/src/app/(authenticated)/media/[id]/mediaPaneFeedback.ts:78` should go
  with them.
- `apps/web/src/lib/media/readerNavigation.ts`: with `ReaderContentsNav` deleted,
  `NormalizedNavigationTocNode` (~:352), `normalizeNavigationTocNodes` (~:360) and
  `parseReaderNavigationHrefAnchorId` (~:368) may have lost their last consumer;
  `decodeMediaNavigationResponse` (~:230) already has none. the module itself must
  stay (`publicationContract.ts` consumes `ReaderNavigationFragment`).
- `apps/web/src/lib/reader/documentMap.ts:8,251` imports `MediaNavigationResponse`
  only to write `MediaNavigationResponse["data"]`. once it imports
  `MediaNavigation` directly, the envelope type can be deleted with its decoder.
- `apps/web/src/components/pdfPaneFind.ts:22`: `pdfFindSourceAccessRefreshAbort()`
  has no production thrower — `PdfReader.tsx`'s proactive signed-URL-expiry
  branches were its only ones and are deleted. its remaining references are a
  proof that throws it itself
  (`usePdfPaneFind.browser.test.tsx:204`) and whatever recognises it in
  `usePdfPaneFind.ts`.

## prerequisites

for each symbol, confirm the last consumer is gone rather than merely moved. for
`pdfFindSourceAccessRefreshAbort`, decide whether the render-error recovery path
should throw it (it never does today) or whether the helper and its handling
retire together.

## proposed fix

delete each item with its handling, in one pass per language so the build never
sits half-cut.

## acceptance

no error code, exported type or helper listed above survives without a producer,
and the typecheck and ruff gates stay green.
