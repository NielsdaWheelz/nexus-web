# media-fact writers move every viewer's collections

status: open · origin: 2026-10-10 podcasts python reauthor (design D4) · area: media ingest / collection revisions

The podcast slice now moves collection families only for a show's audience and
only when a list key can move (`docs/modules/podcast.md`, concepts and owners).
Writers outside it still call `bump_all_media_fact_collections`
(`python/nexus/services/media_fact_revisions.py:14`), which moves every user's
families: transcript source admission
(`media_source_ingest.enqueue_podcast_episode_transcript_source_attempt`,
`services/media_source_ingest.py:1002`), source retries, repairs and terminal
publication (`media_source_ingest.py:1329,1456,1575,1762,1836,1879,2177,2250`),
non-podcast source failures (`source_attempt_failures.py`), and metadata
enrichment completion.

impact: any open podcast or library continuation anywhere answers 409
`E_COLLECTION_CHANGED` when one viewer transcribes an episode or an enrichment
finishes; the client reloads the prefix (bounded, wasted reads). The podpy
harness keeps these writers away from its D4b probe for that reason.

fix: bump the media's audience (the viewers whose collections can list it), and
only for facts that are list keys; transcript and processing states are not.

acceptance: transcribing an episode in one account leaves another account's
podcast and library continuations answering 200.
