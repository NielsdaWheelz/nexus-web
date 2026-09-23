# capture receipt can imply saved before source storage

status: open · origin: 2026-09-23 firefox v1 review · area: capture acceptance

`python/nexus/services/media_source_ingest.py:1075-1077` commits the article row,
destinations and accepted attempt before writing source blobs. a concurrent
same-key replay can return that accepted attempt; `_from_url_response:547-549`
then reports `ingest_enqueued=true` without a queue binding or stored bytes.
`_store_and_enqueue:2393-2396` also returns an ordinary failed receipt after a
source-write error. `apps/extension/popup.js:195-198` labels it saved but ingestion
failed although the captured source may not exist. source-confirmed, not a live
storage-failure reproduction.

fix: let the source owner report whether captured inputs are durably stored,
still being saved, or failed to upload. distinguish this from later processing.
replay/status must verify the required source artifacts or use an authoritative
storage-completion fact; neither accepted nor queued alone proves it, since
`ensure_stale_source_attempt_job:1527-1553` can enqueue an accepted attempt without
checking storage. derive queue reporting from its actual binding.
define retransmission after a known upload failure so replaying the same accepted
identity cannot strand the operation with no source bytes and no repair path.

acceptance: slow/failing blob writes and a concurrent same-key retry never
produce saved or release the client's only bytes prematurely; successful storage
permits a saved receipt while later ingestion continues independently.
