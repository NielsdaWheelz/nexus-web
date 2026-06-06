# Player Module

## Scope

The player module owns audio/video playback: the global player, the playback queue, listening
state, and resolution of a media item's playable source. It is the consumer of podcast
episodes (and YouTube videos) for playback; the [podcast module](podcast.md) owns discovery,
sync, and transcription, and hands episodes to the player via the queue.

Backend owners:

- `python/nexus/services/playback_queue.py` — the per-user playback queue: append, reorder,
  remove, and the `auto_queue` hook that appends newly synced subscription episodes when a
  subscription opts in (`append_subscription_media_if_enabled`).
- `python/nexus/services/playback_source.py` — resolves the playable source for a media item
  (e.g. `external_playback_url` for `external_audio` podcast episodes).
- `python/nexus/services/listening_state.py` — per-user, per-media listening position and
  completion (`podcast_listening_states`), which also feeds the podcast "unplayed" counts.

Frontend owners live under the global player surface mounted in
`apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`, consumed by the media and podcast
panes (`MediaPaneBody`, `TranscriptPlaybackPanel`, `PodcastDetailPaneBody`).

## Boundary With Podcast Sync

Playback never fetches feeds or writes transcripts. On sync, the podcast module persists the
episode + its `external_playback_url` and (when `auto_queue` is enabled) calls
`playback_queue.append_subscription_media_if_enabled`. The player then resolves and streams
that source and records listening state. The transcript shown alongside playback is the
current transcript rendered from media fragments; the player does not own transcript state.
