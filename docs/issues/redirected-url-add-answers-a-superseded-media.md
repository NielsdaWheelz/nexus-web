# a redirecting url add answers a media that is then superseded

status: open (narrowed by the ingest reauthor, 2026-10-14; folds the tickets
`readded-url-returns-a-media-id-that-is-then-superseded`,
`readding-a-url-answers-created-for-a-media-that-is-deleted` and
`canonical-source-teardown-deletes-admission-replay`).
area: ingest / url admission (`python/nexus/services/media_source_ingest.py`).

problem: admission reuses a web article only when its `canonical_url` equals the
normalized requested url (an exact re-add answers the article at once). a url whose
final url differs (a redirect, a tracking parameter the page canonicalizes away)
still gets a new media; the run finds the holder of the final url, supersedes onto
it and claims the new media for teardown, so `GET /media/{id}` of the answered id
turns 404. after the teardown deletes the attempt rows, a resend of the same client
id finds no attempt and admits another media that is superseded again.

impact: the Add panel's Open, the share page's Open in Nexus and a lost-answer
resend can land on a deleted media for a redirecting url.

evidence: `_reusable_media` (generic web arm) and `source_runner._supersede`;
the teardown deletes attempts (`services/media_deletion.py`).

resolved when: an add of a redirecting url answers (or the client follows) the
surviving media, and a resend of its id after teardown answers that media instead
of admitting a new one.
