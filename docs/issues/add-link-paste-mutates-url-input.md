# the link parser drops a url's own terminal punctuation

status: open
origin: 2026-10-13 add/import editor design review; restated 2026-11-02 when the add
editor and its `addInput.ts` were deleted (import build, slice 2)
area: web / nexus query, the import page and share capture

`apps/web/src/lib/extractLinks.ts` is now the one parser for root, the import field and
share. it splits glued urls and keeps balanced brackets
(`https://en.wikipedia.org/wiki/Function_(mathematics)` survives), but `trimProse` still
strips every trailing `.,;:!?'"`: `https://example.test/?q=why?` sends as
`https://example.test/?q=why`. the add editor, which kept such urls verbatim, is gone, so
no surface sends one as written.

impact: a url whose last character is its own punctuation imports a different address;
the stripped character is silently dropped from `rest` too.

resolved when: the parser tells prose punctuation from a url's own (for example, keep a
terminal `?` or `!` inside a query or fragment), and root, the import field and share
send such urls as written.
