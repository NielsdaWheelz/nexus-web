# artifact web acceptance commits inside build transaction

status: open
origin: 2026-09-26 processing-recovery implementation review
area: artifact research and source admission

`services/artifacts/web_pages.py:143` calls `accept_url_source` inside the
artifact research operation. `services/media_source_ingest.py:_accept_url`
commits source acceptance and its job before returning. the artifact owner then
continues its own result and build writes. a later build failure cannot roll back
the source acceptance, leaving an accepted media item without the matching build
receipt. this composition was outside the processing-recovery source slice.

the artifact owner must decide whether acceptance is part of the build
transaction or an independent intent with a durable receipt. then align the
commit boundary with that decision; preserve source job durability and replay.

acceptance: fault after url acceptance but before the artifact result commit;
the durable source/build relationship follows the chosen contract, and replay
does not create duplicate source attempts.
