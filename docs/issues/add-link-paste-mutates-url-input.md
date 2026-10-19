# shared prose extractor can combine urls and remove valid punctuation

status: deferred; add/import repaired and live-qualified, remaining callers source-only
origin: 2026-10-13 add/import editor design review and hard cutover
area: web / nexus query and share capture

`apps/web/src/lib/extractUrls.ts:2` treats
`https://a.test/x,https://b.test/y` as one url-shaped token. that token has a
valid first host and a path containing the second url. line 5 also strips valid
terminal characters:
`https://en.wikipedia.org/wiki/Function_(mathematics)` loses its closing
parenthesis, and `https://example.test/?q=why?` loses its final question mark.

rejected url-shaped tokens are silently omitted. remaining callers are
`apps/web/src/lib/nexus/query.ts:85` and
`apps/web/src/app/share/ShareCapture.tsx:71`.

add now uses `components/nexus/addInput.ts`, preserves punctuation and invalid
raw text, and offers explicit ambiguous splitting. its 20 isolated live cases
pass. the owner explicitly deferred changing the shared prose capability;
share's existing prose extraction is preserved and live-qualified.

prerequisite: define how nexus query and share capture distinguish surrounding
prose punctuation from literal url punctuation. repair the shared extractor at
that boundary without importing add's raw-list grammar into prose capture.

acceptance: these callers retain valid parentheses, terminal query punctuation,
commas and fragments; prose wrappers resolve according to their explicit
contract; ambiguous/malformed sources are recoverable. qualify both callers.
no live reproduction of their remaining parser defect is claimed.
