# re-adding an ingested url answers `created` for a media that is then deleted

status: open, reproduced on the index harness (not fixed: url acquisition owns it).
origin: 2026-10-10 content index reauthor harness (branch cleanup/content-index-reauthor), coordinator item R7(a).
area: url acquisition / canonical supersession.

on a stack where `http://pages.c2ix.example:8080/heath-article` was already
imported and ready (media `30edbce7…`), a second `POST /media/from_url` for the
same url with a fresh `Idempotency-Key` answered `202` with
`{"media_id": "2084706f…", "idempotency_outcome": "created", "processing_status":
"pending", "ingest_enqueued": true}`. that media ingested, was found a canonical
duplicate of the first and superseded: a `media_teardown` job was enqueued 20 s
later and `GET /media/2084706f…` then answered `404 E_MEDIA_NOT_FOUND`. the client
was told it created a media it can never open; the add flow and any capture that
follows the returned id land on a 404 (`services/media_source_ingest.py`
supersession → `delete_duplicate_document_media`).
evidence: index harness exploration stack 2026-10-10 18:48-18:55 utc (api 26221).

fix: either admit a url whose canonical media already exists as `reused` with
that media's id, or answer the winner once supersession settles (the client
follows a stable id); keep loser teardown for genuine races.

acceptance: re-adding an ingested url with a new key answers an id that opens
(the existing media, or one that survives); the harness journeys can drop the
`C2IX_TAG` exploration lever that works around this.
