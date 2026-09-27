# storage unavailability is treated as proof the source is lost

status: open
origin: 2026-09-26 static source-recovery review
area: stored-source recovery

`services/media_source_ingest.py:142-145,245-255` includes `E_STORAGE_ERROR`
in non-reacquirable file errors, alongside confirmed `E_STORAGE_MISSING`.
`storage/client.py:118-129` raises the generic code for failed metadata reads;
that proves no permanent loss. source recovery can therefore refuse a retained
file after a transient storage outage. none of the current 25 source failures
has this code; this is a separate latent defect.

distinguish confirmed absence from unavailable/unverified storage. verify the
owned object before admitting recovery, preserve its identity, and report a
retryable availability failure when that verification cannot complete.

acceptance: transient head failure never claims permanent loss; recovery works
after storage returns; a confirmed missing object still requires new input.
