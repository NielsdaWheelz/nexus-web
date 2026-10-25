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
