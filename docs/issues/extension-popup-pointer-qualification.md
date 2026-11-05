# qualify native wheel delivery in the extension popup

on `af131cf48`, stock firefox 158.0.1 delivers trusted pointer activation and
typing into the installed one-click popup. permission/sign-in, library disclosure,
filter typing and reviewed removal activation have been observed. the previous
capture draft/held-notice workflow was removed by this cutover.

wheel qualification remains open. an owned headless webdriver wheel action
returned success, but the popup received no wheel event and its library list stayed
at scroll top zero. exact popup/embedder rectangles work for pointer activation;
they did not establish wheel delivery. this is a tooling limit, not evidence of a
product scrolling defect. the 2026-11-04 owner decision is to continue headless and
leave this qualification open; visible/native desktop verification was declined.

2026-11-05 disposition for `191ae44612d22626251a0d17950d3077d89650da`:
`NOT_RUN`, owner-deferred. the separate waiver of the signed extension's installed
smoke check does not expand desktop approval or qualify wheel delivery.

owners: `apps/web/src/extension/popup.tsx` and the native firefox qualification
caller of `python/scripts/lab_firefox.py`. establish the supported wheel input
context without geometry changes, javascript scrolling or a product seam.

resolved when an ordinary trusted wheel event reaches the actual popup list and
changes its scroll position, with its controls still usable. keyboard scrolling
does not substitute for that observation. desktop access requires a new scoped
approval. the separate stopped lost-answer oracle remains prohibited.
