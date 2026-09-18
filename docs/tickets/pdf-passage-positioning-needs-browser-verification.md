# pdf passage positioning needs browser verification

status: open · origin: 2026-09-17 passage navigation cleanup, base 1bee992eb · area: pdf navigation

the new passage target calls the existing `PdfReader` control
`applyResumeState` after controls become ready and consumes the hash only after
its successful positioning receipt. source review and static checks passed;
actual pdf viewport positioning is `NOT_RUN`.

the temporary standalone actual-renderer harness repeatedly fetched
`/pdfjs/pdf.worker.min.mjs`, remained `page 1 of 0 / loading pdf`, and never
requested its valid local pdf or exposed controls. no browser/request error
remained after stabilizing harness props. this is an isolated setup blocker,
not evidence of production success or failure. the harness was removed.

acceptance: in a working media pane, open a passage after pdf mount and then a
different passage in the same pane. verify both target pages enter the viewport,
hashes clear only after positioning, and navigation away cancels pending work.
