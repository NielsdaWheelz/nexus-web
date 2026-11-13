# pdf page navigation can classify the previous page

status: open · origin: 2026-10-16 pane-tabs live verification · area: reader / pdf navigation

problem: in webkit, a real Page4/5 command can settle with the requested page
less than1px below the reading line and display the previous page number.

impact: exact page entry appears to fail; the reader's navigation and position
classification disagree before any pane operation.

evidence: isolated build`4c3a01e0b`, real8-page pdf at zoom2: target page top
`265.375`, reading line`264.59375`, delta`0.78125`. a genuine40px wheel step
immediately classifies the requested page. `PdfSurface.tsx:406` accepts an arrival
within2px; capture at`:185` chooses the next page only at/before the line.
owner: `apps/web/src/lib/documentReader/pdf/PdfSurface.tsx`.

also observed in chromium at `68836fa2f`, lab
`20261112-230927-5f7e4afa5d4e`, with a twelve-page pdf: after restoring fitted
width and resizing, page 5's top was 205px against a 204px reading line, and the
field said 4. after leaving for notes and returning in the same pane, the top
and reading line were both 204px and the field said 5. the saved cursor stayed
unchanged. firefox's corresponding journey had zero delta and said 5. this is
the same boundary classification defect; fitted mode and the physical reading
place survived return and subsequent resizing.

reproduce: use numeric zoom2 and Page entry to jump between pages4/5 in webkit;
compare the requested page's top with the reader's reading line after settling.

proposed fix: make navigation arrival and page classification share a consistent
coordinate/rounding contract. do not add a pane-layer offset or fake progress.

acceptance: real page entry settles on the requested page across all three
engines without requiring a wheel correction; verify saved-cursor semantics
and subsequent both-axis pane-reorder offsets within1css pixel.
