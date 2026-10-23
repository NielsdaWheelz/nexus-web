# publisher transcript find remains unqualified

problem: the original reader-navigation acceptance included finding text within
a publisher transcript. that part has not been observed.

observed: podcast collection qualification used real darknet diaries discovery,
feed sync, acquisition and explicit transcription. the result reported
`transcript_origin=Publisher`, readable content and real reader cursor saves.
publisher reading is qualified; reader find remains open. discovery-only sidecar
observation has its own [issue](podcast-discovery-misses-publisher-transcript.md).

resolved when: the real reader finds a passage in that publisher transcript,
with the source distinguished from generated transcription. use task-owned
podcast-index credentials and a known publisher transcript; no generated
transcription is needed for this check.
