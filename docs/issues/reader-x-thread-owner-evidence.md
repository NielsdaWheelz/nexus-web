# x thread readers omit owner posts' server evidence

problem: the media pane reads the server document map only for the mounted media.
an x thread's units belong to owner post media; their derived server evidence
(apparatus source references, assistant and discovery links) lives in each owner's
own document map and is no longer read.

impact: in a thread view, citations and librarian links anchored to owner posts do not
appear in the connections pane or rail. local highlights and notes on owner posts are
unaffected: the local annotation controller reads every owner source.

evidence: `apps/web/src/app/(authenticated)/media/[id]/annotations.ts` `readRemote`
fetches `/api/media/{mediaId}/document-map` once. the previous store subscribed one map
per `xPost.owner.media_id` and fenced each by an identity composed as `g<generation>`.
the reader document map has no explicit publication generation to fence owner maps
without that string grammar.

proposed fix: add `publication_generation` to `ReaderDocumentMapOut`, then read each
owner's map and place its roots only when that generation equals the mounted
`xPost.owner.generation`; map owner fragment locators onto the mounted units.

resolved when a thread whose owner post has an apparatus reference or assistant link
shows it in the connections pane at its passage, and a changed owner publication shows
it as location unavailable instead of misplacing it.

actual old-source red: checkpoint227, canonical lab
`20261026-214625-60abed6e1a49`/session78646, frozen
`x-owner-evidence.py`57703 + casea313. the standalone owner map resolved the
actual canonical fragment, the mounted thread reported the same owner generation,
and the local highlight control rendered. the owner-derived row was absent
(case52). earlier214033 failed fixture setup by confusing an X occurrence id
with its canonical owner fragment; it established no product verdict.

source repair now reads the distinct mounted owner maps in the existing per-pane
controller, reuses the local source-unit ownership contract and requires explicit
publication generation per occurrence. canonical roots/direct facts dedupe while
decorations keep repeated occurrences. new document objects cancel old read waves
even when identity is unchanged; removed owners cannot retain cached paint.
generated wire and repaired-source qualification remain pending. the disposable
case qualifies owner-map composition, not X provider acquisition or apparatus
extraction: its derived apparatus uses the existing owner API after actual fenced
canonical X publication.
