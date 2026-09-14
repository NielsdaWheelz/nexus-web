# stance target resolution has no addressed read; the common case still costs a page

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: reader stance / publication query surface

## what is wrong

resolving the stance for one target has no addressed server route, so the client
walks evidence-association pages. the unbounded, uncancellable drain is fixed —
`resolveStanceTarget` now takes the composer's real `AbortSignal` and walks at
most `STANCE_ASSOCIATION_MAX_PAGES = 16` pages of
`STANCE_ASSOCIATION_PAGE_LIMIT = 100` — but the **common** case ("this target has
no stance yet") still costs one full association page read, proved to be exactly
one by `MediaPaneBodyStanceChord.browser.test.tsx` asserting
`associationRequests === [null]`.

## prerequisites

a bounded single-row stance lookup on the publication query surface. it touches
`python/nexus/api/routes/reader_publications.py`, then
`apps/web/src/lib/reader/ReaderDocumentSource.ts`,
`apps/web/src/lib/reader/DocumentReaderSession.ts` and the
`MediaPaneBody.tsx` call site.

## proposed fix

add the addressed stance read, and make the association walk the fallback for the
listing surface only.

## acceptance

pressing a stance control on a target with no stance issues one addressed read
and no association page; the composer still supersedes correctly when pressed
twice.
