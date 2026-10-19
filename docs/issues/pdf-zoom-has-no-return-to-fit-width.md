# pdf zoom has no return to fit width

status: open
origin: 2026-10-16 principal-action source audit
area: web / document reader / pdf navigation

pdfs initially fit pane width and refit on resize
(`apps/web/src/lib/documentReader/pdf/PdfSurface.tsx:368-374`). a zoom command
replaces that mode with a number (`:513-516`). the navigation offers only zoom
out/in (`apps/web/src/lib/documentReader/chrome/ReaderNavigation.tsx:129-136`),
and the public reader command accepts only a number
(`apps/web/src/lib/documentReader/runtime.ts:93-94`). there is no command to
restore fit-width behavior. the persisted numeric zoom can preserve the choice
on return (`runtime.ts:298-299`). this is source-derived, not browser-verified.

prerequisite: retain the distinction between chosen zoom and fitted width;
numeric 100% is not fit width. add an explicit fit-width command at the reader
owner and expose it with the zoom controls. if replacing the zoom menu with
minus/scale/plus, let the scale control offer a clearly named fit-width reset.
reuse existing pdf.js scale handling and cursor persistence.

acceptance: zoom a fitted pdf, restore fit width, then resize its pane and
leave/return. the pdf keeps fitting width with its reading location preserved.
the displayed scale/mode and accessible control names describe the result.
