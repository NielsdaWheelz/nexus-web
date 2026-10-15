# the transcript request reason vocabulary is written twice

status: open · origin: 2026-10-10 content index reauthor design review (branch cleanup/content-index-reauthor) · area: transcripts / wire

`python/nexus/schemas/media.py:488-490` declares `TranscriptRequestReason` (six
values) for the http contract, and `python/nexus/services/transcripts/request_reason.py:7-15`
declares a second `TranscriptRequestReason` with a seventh value, `rss_feed`,
which the database CHECK `ck_media_transcript_states_last_request_reason` also
admits. nothing writes or reads `rss_feed` (the share gate reads
`transcript_origin` since 2026-10-14, cleanup/atlas-share-reauthor). two
vocabularies for one fact drift silently.

fix: keep one vocabulary (the wire's six values) owned by
`transcripts/request_reason.py` and imported by the schema, and narrow the CHECK
in a migration.

acceptance: one `TranscriptRequestReason` definition; `git grep rss_feed` finds
only migrations; requests and the job row round-trip every reason.
