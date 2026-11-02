# the outline clipboard reader has no caller

origin: 2026-11-01 annotation emptying review, source only · area: web outline
clipboard

`readOutlineClipboard` (`apps/web/src/lib/notes/clipboard.ts:24`) is exported and
never called, so the `application/x-nexus-authored-outline+json` payload that
`writeOutlineClipboard` writes is never read back. a paste parses only `text/html`.

impact: dead code, or a lost paste path. check the unpushed local-first outline work
before deleting it; it may be the intended caller.

resolved when the reader has a caller that a paste reaches, or it is deleted with the
payload it reads.
