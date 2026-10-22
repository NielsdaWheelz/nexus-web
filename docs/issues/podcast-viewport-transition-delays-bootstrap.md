# viewport transition delayed workspace bootstrap

baseline `380400362c03`, disposable live review on 2026-10-21: after a 390px
libraries sheet was closed, resizing to 720×500 and loading the podcast url
returned html in 64ms and static assets in about 1ms, but bootstrap api requests
began about 16 seconds later. the pane stayed on “loading podcast…”, exceeding
the driver's ten-second assertion. detail reads themselves completed in 5–7ms.

evidence: private baseline trace at
`.nexus-local/lab/20261021-155109-3f8056e414f6/artifacts/playwright/podcast-pane-controls-desk-29bf4-ow-the-real-header-journeys/trace.zip`;
navigation at 23:02:15.686 utc, bootstrap requests from 23:02:31.599.
cause and repeatability are unresolved; no slow backend is established.

the controls change qualifies independent desktop/narrow arrivals; it does not
qualify this rapid sheet-close/resize/reload sequence. resolve by reproducing the
delay, identifying its browser/bootstrap owner, and verifying that sequence
starts the correct pane's reads promptly without disturbing overlay history.
