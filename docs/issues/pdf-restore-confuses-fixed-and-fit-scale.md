# pdf restoration confuses fixed zoom and fit width

status: open
origin: 2026-10-16 principal-actions plan review
area: web / document reader / pdf restoration

`PdfSurface.tsx:368` initializes `page-width`. saved numeric zoom reaches
`setZoom` through `runtime.ts:298-299`, but `PdfSurface.tsx:513-516` returns when
the requested number equals `viewer.currentScale`. equal effective scale does
not establish equal mode: a saved fixed percentage can remain in fit-width mode
and change on the next resize. conversely, returning to fit width must restore
responsive behavior even when its effective percentage matches fixed zoom.
paths are under `apps/web/src/lib/documentReader/`; evidence is source-derived,
not browser-verified.

prerequisite: preserve numeric zoom versus null fit-width as distinct choices.
compare the chosen mode as well as effective scale when applying/restoring zoom
at the existing pdf surface owner. no new preference or persistence path.

acceptance: restore fixed zoom into a pane where fit width initially produces
the same scale, then resize; zoom stays fixed. explicitly choose fit width at
that same scale, then resize; it follows width. reading location and existing
movement-only persistence remain intact.
