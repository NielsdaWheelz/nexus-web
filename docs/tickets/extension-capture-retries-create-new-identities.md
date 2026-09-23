# extension retries create new capture identities

status: open · origin: 2026-09-23 firefox v1 review · area: extension / ingest

`apps/extension/popup.js:168-175` generates an idempotency key for every post.
after a lost response, retry has a new key. browser article/file acceptance
replays only a matching key then creates a new media row
(`python/nexus/services/media_source_ingest.py:1013-1037,1127-1152`). an accepted
capture can therefore be duplicated by retry. no live duplicate was created
during this read-only review.

the backend replay fingerprint also binds byte lengths rather than payload
contents (`media_source_ingest.py:1007-1011,1124-1126`): different same-sized
payloads with the same key can be treated as the same intent.

fix: generate and retain one key and immutable request per save intent; reuse
them after ambiguous transport failure. preserve the key across popup closure.
bind replay to a digest of the actual immutable payload and relevant metadata.
separately specify deliberate repeat-save behavior; never resolve this by
globally deduplicating private browser content by public url.

acceptance: dropping a successful response then retrying returns the same media
and destination result; changed source/selection is not silently replayed as the
old request; private captures do not become another user's canonical content.
