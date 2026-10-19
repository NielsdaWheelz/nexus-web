# pdf position drifts across mobile composition

status: open · origin: 2026-10-16 pane-tabs live verification · area: reader / responsive position

problem: chromium/firefox shift a numeric-zoom pdf's reading line by about21px after a
desktop→mobile→desktop round trip. the page stays5, body stays mounted and the
saved cursor is unchanged; exact pixel position is not preserved.

evidence: isolated build`4c3a01e0b`, one-pane control: scrollTop
`12915.2002→12936→12936`, scrollLeft`200`, same body and saved revision5/page5/zoom2,
zero progress writes. one unchanged wrapper means the canvas performs no capture
or replay. the two-pane control shifted20.6px. responsive padding changes in
`apps/web/src/lib/documentReader/documentReader.module.css:329`; the exact
browser/reader cause remains unassigned. final outcome: #653.

reproduce: open a real multi-page pdf at numeric zoom2/page5; record reading-line
geometry; resize desktop→390csspx→desktop, waiting for each committed mobile
classification. compare the same page's position against the reading line.

proposed fix: investigate native anchoring against reader-owned responsive
geometry in`lib/documentReader/pdf/PdfSurface.tsx`; repair that owner without
replaying history or saving synthetic progress. no new canvas workaround.

acceptance: the same logical content anchor survives the committed round trip,
with unchanged body/cursor and no unintended progress write; repeat in all three
engines. pure pane reorder must still preserve both scroll axes.
