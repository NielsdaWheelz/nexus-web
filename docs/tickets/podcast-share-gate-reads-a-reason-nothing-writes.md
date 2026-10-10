# the podcast share gate reads a request reason nothing writes

status: open · origin: 2026-10-10 content index reauthor design review (branch cleanup/content-index-reauthor) · area: resource sharing / transcripts

`python/nexus/services/public_resource_sharing.py:122` makes a podcast episode
shareable only when `media_transcript_states.last_request_reason = 'rss_feed'`.
no writer stamps `rss_feed`: transcript requests carry the viewer's reason
(`episode_open`, `search`, ...; `schemas/media.TranscriptRequestReason`), and the
podcast transcription run stamps the job's request reason even when the text came
from the publisher's rss sidecar. so no episode is ever shareable, including
publisher-transcribed ones. the fact the gate wants is the transcript's origin:
`media_transcript_states.transcript_origin = 'Publisher'`, written by
`services/podcasts/transcription.py` for sidecar transcripts.

fix: gate on `transcript_origin = 'Publisher'` (read with the other facts) and
drop the `rss_feed` reason if nothing else needs it
(see [transcript-request-reason-vocabulary-duplicated](transcript-request-reason-vocabulary-duplicated.md)).

acceptance: an episode transcribed from its publisher's sidecar is shareable; a
Deepgram-generated one is not; a youtube video's rule is unchanged.
