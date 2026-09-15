status: open
origin: 2026-09-12 reader cutover input review, `329bac8622`
area: hosted pdf controls / consumption activity

`MediaPaneBody.tsx:4903` calls both genuine-reader input owners before every pdf
control action, including zoom at `:5729` and `:5739`. `PdfReader.tsx:3348` and
`:3360` only change zoom and positioning. zoom can therefore make the current
reader viewport eligible for reading time without a page or prose gesture.
paths are under `apps/web/src/app/(authenticated)/media/[id]/` and
`apps/web/src/components/`, respectively.

prerequisite: retain ordinary page-turn intent, explicitly supported by
`docs/cutovers/reader-progress-continuity-hard-cutover.md:387`. separate zoom's
layout change from page-turn input in the existing control owner. do not add a
second activity recorder or infer reading from resulting programmatic movement.

acceptance: the real control/recorder boundary keeps a restored reader idle after
zoom; page turning and prose input still adopt reading. demonstrate the existing
zoom counterexample before fixing it. this is separate from map/section/source-link
orientation in the document-map cutover.
