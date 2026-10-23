# transcript highlight admission rejects its publication identity

main's writing cut requires `EnsureMediaHighlightRequest.expected_reader_generation`
to be an integer >= 1. transcript documents retain a segment-id identity (`t...`)
and have no `reader_publications` generation. the current browser composer also
throws when `annotations.prepareCreate` sees that null generation.

impact: creating a highlight on a readable podcast/video transcript fails before
or at admission. inserting a synthetic publication row in a fixture would conceal
the product contract conflict.

evidence at integrated commit `ba1947159`: actual authenticated
`GET /api/media/{transcript fixture}` returned 200, kind `podcast_episode`,
`reader_generation: null`; a complete null-generation request returned 400
`E_INVALID_REQUEST`; changing only its generation to 1 reached the source fence
with 409 `E_READER_CONTENT_CHANGED`. see `python/nexus/schemas/highlights.py:122`,
`python/nexus/services/reader_publication.py:35`,
`apps/web/src/app/(authenticated)/media/[id]/annotations.ts:495`, and the writing
journal decoder's passage request in `apps/web/src/lib/notes/journal.ts`.

repair the owner contract without inventing a prose publication generation for
transcripts. preserve the authored uuid/ack protocol and explicit source fencing.
resolved by actual transcript selection/highlight creation and durable reload
through the writing owner, plus the paused playback/selection/find stability case.

main `e719bf52f` repairs the required nullable generation contract at all four
owners. integrated actual composer, initial-note and durable-paint proof remains
pending; no synthetic transcript publication is admitted.
