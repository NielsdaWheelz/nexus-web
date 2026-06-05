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
