# Video

Video ingest is source-owned.

`media_ingest.py` forwards URL requests to `media_source_ingest.py`.
`media_source_ingest.py` classifies supported YouTube URLs, creates or reuses
canonical video media, records the source attempt, and enqueues
`ingest_media_source`. `youtube_video_ingest.py` owns YouTube materialization
once the source attempt is running; it is not a separate source-acquisition queue
lane.

`media.py` may list and hydrate video media rows, but YouTube URL parsing,
accepted source attempts, retry, and refresh do not live in the catalog service.

## Browse, Preview, And Transcribe

Browse uses the read-only YouTube adapter under `services/browse/` for search and
Preview. It returns sealed discovery targets, refetches provider truth on
Preview, proxies remote artwork, and exposes the official allowlisted YouTube
iframe only after explicit click-to-load. Browse and Preview create no Media,
source attempt, transcript state, playback progress, or activity fact.

Add passes the server-resolved canonical YouTube URL to `/media/from_url`, which
reuses the normal source-attempt owner above. `youtube_video_ingest.py`
materializes playable metadata only. Captions are fetched only by an explicit
canonical Video Transcribe command through `youtube_transcripts.py`; Add never
starts transcript work.
