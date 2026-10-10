# youtube caption import runs inside the api request

status: open (harness observation O2, 2026-10-09, re-read against source).
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: transcripts / youtube.

the observation "the youtube video ingest fetches captions itself" does not hold:
`youtube.run_youtube_video_ingest` never calls the caption provider. the
explicit transcript request does it synchronously:
`POST /media/{id}/transcript/request` → `podcasts/transcription.py:83`
`_import_youtube_captions` → `fetch_youtube_transcript` (`:443`) inside the
request, then answers 200 with the transcript installed (nothing enqueued). the
request thread is held for the provider call: up to
`YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS` per http call, repeated per proxy retry
when youtube blocks.

this is outside the url acquisition slice's call boundary (the transcription
owner chooses inline import; the slice provides `fetch_youtube_transcript`).

fix, if request latency matters: enqueue a `video_transcript` source attempt
and answer 202, as podcast episodes do.

acceptance: the transcript request answers without waiting on youtube; the
transcript lands through the source runner.
