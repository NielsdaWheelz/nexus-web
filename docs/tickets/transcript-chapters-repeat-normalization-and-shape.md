# transcript chapters repeat normalization and shape

status: open
origin: 2026-10-02 cleanup discovery, origin/main 56b889bdc
area: web / media transcript

`mediaDetail.ts:172-196` strictly decodes all chapter fields, but
`transcriptChapters.ts:37-68` validates, clamps, trims, filters, and sorts them
again. three consumers repeat this projection: `TranscriptPlaybackPanel.tsx:255`,
`TranscriptContentPanel.tsx:178`, and `transcriptPaneFind.ts:127`, all under
`apps/web/src/app/(authenticated)/media/[id]/`. `TranscriptChapter`,
`ChapterInput`, and `GlobalPlayerChapter` describe the same chapter facts with
different optionality. this obscures the data contract and repeats presentation
policy across playback, rendered contents, and find.

prerequisites: preserve title trimming, blank-title omission, ordering by start
then chapter ordinal, and ambiguous-interval handling. normalize once at the
media detail boundary, remove impossible validation/clamp branches after strict
decoding, and use one required-nullable chapter type. retain interval resolution
in its semantic owner.

acceptance: chapter contents, playback seeks, and transcript find use the same
ordered chapter list; blank titles and tied starts retain their current
behavior. no duplicate chapter-shape type or consumer normalization remains.
`./scripts/test` passes; manually verify a chaptered episode.
