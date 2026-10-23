# discovery-only acquisition misses publisher transcript references

problem: adding a discovered episode without feed sync creates its source facts
without the publisher transcript sidecar. explicit transcribe therefore selects
generated transcription even when the feed advertises a supported publisher vtt.

evidence: `python/nexus/services/podcasts/episode_acquisition.py:33-41` constructs
`EpisodeFacts` without `transcript_url`; `feed.py:64` defaults it to null.
`transcription.py:222-242` skips publisher acquisition when that reference is
absent. feed sync supplies it, and `ingest.py:358` preserves it on later adds.
darknet diaries episodes 180/181 advertise reachable vtt sidecars; discovery-only
acquisition does not observe them. this is source-derived; the isolated
discovery-only failure has not been run as a qualification case.

impact: a publisher transcript may require following/syncing first, or a generated
transcription credential/cost that the source itself would not require.

resolved when: ordinary discovery acquisition followed by explicit transcribe
reads the publisher text without following the show or using generated
transcription. repair source observation at its owner; retain explicit admission
and existing safe-fetch rules. independent of podcast pane composition.
