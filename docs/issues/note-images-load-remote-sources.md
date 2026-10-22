# note images load any source

status: open · origin: notes re-slice design Q6, 2026-10-21 · area: notes / body grammar

a note body's inline `image` takes any string `src`: python checks only that it is
text (`python/nexus/schemas/note_bodies.py:75`) and the editor's schema parses any
pasted `img[src]`, data uris included (`apps/web/src/lib/notes/noteBody.ts:72-83`).
rendering a note then fetches whatever host the src names, and a pasted data uri can
make a body too large to save (refused at build since the re-slice; notes harness
`bodies/B28`).

impact: opening a note can contact a third-party host chosen by whoever wrote the
pasted html; large inline images make notes unsaveable from the web.

evidence: source above; census on the 8a67 backup (2026-10-21, count-only): no
note holds an image, so restricting `src` converts no stored row today.

fix: decide a `src` policy at the grammar's owner (http(s) and same-origin paths,
or uploaded media only), enforce it in `validate_body` and mirror it in the web
schema's `parseDOM`, with a census of stored image sources first.

resolved when both grammars refuse an image `src` outside the decided policy and a
pasted remote or data-uri image follows it.
