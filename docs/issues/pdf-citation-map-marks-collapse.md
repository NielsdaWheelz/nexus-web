# pdf citation marks collapse at the end of the document map

status: open (reader read half, 13b)
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness/defects.txt` N6)
area: reader document map (web rail)

attention.pdf's 76 bibliography markers sit on pages 2-10 with correct
`pdf_page_geometry` locators in the document-map api, but the desktop rail draws
them as one group "76 destinations near 100% through document", at load, after
15 s and after paging to page 4.

impact: the rail cannot take a reader to a pdf citation; every mark claims the
end of the paper. evidence: harness journey `P1.pdf-upload-reader-desktop`
(evidence string), `prep/pdfmap.mjs`.

resolved when P1's rail shows the markers at their pages' fractions (pages
2-10 of 15).
