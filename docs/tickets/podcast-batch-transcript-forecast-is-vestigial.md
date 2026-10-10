# the podcast batch transcript forecast is vestigial

status: open · origin: 2026-09-27 cleanup pr-03 (delete billing) · area: podcasts / transcript api

with billing gone, `POST /media/transcript/forecasts` returns only
`{eligibleCount, selectionFingerprint}`
(`python/nexus/schemas/podcast.py:306`,
`services/podcasts/transcription.py::forecast_podcast_episode_query_transcripts`).
its one caller, the "Transcribe all" command in
`apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx`
(through `forecastEpisodeTranscripts` in `lib/podcasts/api.ts`), shows the count in a `window.confirm` and echoes the fingerprint into
`POST /media/transcript/request/batch`, so a batch is two round trips whose
first exists to keep a count-only confirm exact against a changing selection.
the forecast name now overstates it. `PodcastEpisodeQueryTranscriptRequest`
(`schemas/podcast.py:313`) is `extra="forbid"` and requires
`selection_fingerprint`, so neither side can drop the field in one release.

fix, by owner choice:
- keep it as the selection exactness guard and rename the route and service to
  say so (`count`, not `forecast`); or
- (a) make `selection_fingerprint` optional and release the backend, stop
  sending it from the web, then delete the field and the forecast route; or
- (b) accept a flagged 422 window and remove both at once.

acceptance: one POST per batch request, or a recorded decision to keep the
guard with names that describe it.
