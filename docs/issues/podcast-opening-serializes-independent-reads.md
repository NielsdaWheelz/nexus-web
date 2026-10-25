# cold podcast opening serializes independent reads

without a saved catalogue, the first episode request waits for its heading.
this adds a round trip; its latency impact is unmeasured. the server can identify
and authorize both reads independently.

evidence: `PodcastDetailPaneBody.tsx:181-184` gates the episode key on a ready
heading or saved show; `services/podcasts/episodes.py` independently checks the
show. the existing source fingerprint is an observation, not a durable publication
revision, so simply removing the gate can expose a stale episode prefix during
ingestion.

resolve at the collection read owner: publish a coherent heading and episode index
without the extra initial dependency. qualify concurrent ingestion, missing shows,
account changes, saved/live promotion and back/forward navigation. this follow-up
is outside the catalogue/membership cutover.
