status: open
origin: 2026-09-13 bounded-workspace reader integration
area: retained publication / EPUB internal navigation

legacy `epubHelpers.ts:74` supports arbitrary authored anchors and compares
browser URL pathnames. the initial retained projection stored only navigation
sections and discarded other authored ids. direct raw href equality also loses
Unicode/space paths and changes literal-percent semantics.

implemented: separate authored anchor index/SQL projection, exact canonical
marker offsets and zero-text unit keys, missing-target rejection, source-bound
locator reopen. source producer red `54b75494f0d9f4dc`, API/producer green
`d34117b45c6e0638`. original href/id remain authoritative; private SHA lookup
avoids PostgreSQL's long-key limit and checks originals. Node now stages exact
legacy pathname normalization once per publication; a private target pathname
hash index supports its lookup without rewriting locator identity.

remaining: finish worker/browser/native conformance on the shared
`epub-pathnames.json` corpus, prove normalized-alias first-match behavior and
selected-generation lookup plans over retained history, then integrate all
readers. no whole-index drains, synthetic sections, or current-alias fallback.
