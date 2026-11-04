# external episode media subjects have no producer

problem: every producer of an `External` `MediaSubject` passes `epub`, `video` or `web_article`,
yet `media_kind` still admits `podcast_episode`. lane 1 retired the playback arm only. what is left
for such a subject is unreachable: the `AddEpisodeToAll` arm, the `All` destination, and the
`Episode` acceptance path through `acquirePreviewMedia` and `resolvePodcastEpisode`.

evidence: `apps/web/src/lib/media/mediaSummary.ts` (`media_kind: MediaSummary["media_kind"]`);
producers at `lib/collections/presenters/browse.ts:52`, `app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:126`,
`app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx:247`; unreachable branches at
`lib/actions/useMediaActions.ts` (`kind === "podcast_episode" && mediaId === null`) and
`lib/actions/mediaContinuation.tsx` (`accepted?.kind === "Episode"`, `destination.kind === "All"`).

impact: dead acquisition code that reads as supported. no user effect. it was left because it is
acquisition, not audio preview, and decision 3 retires only the latter.

resolved when `External.media_kind` excludes `podcast_episode` and those branches are gone, or a
producer exists and is qualified.
