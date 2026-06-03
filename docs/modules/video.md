# Video

Video ingest is source-owned.

`media_ingest.py` classifies supported video URLs and dispatches YouTube URLs to
`youtube_ingest.py`. `youtube_ingest.py` owns canonical YouTube identity, video
media row creation/reuse, and `ingest_youtube_video` job enqueueing.

`media.py` may list and hydrate video media rows, and source refresh may delegate
to `youtube_ingest.py`, but YouTube URL parsing and ingest rules do not live in
the catalog service.
