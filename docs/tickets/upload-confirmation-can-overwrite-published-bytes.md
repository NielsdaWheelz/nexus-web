# concurrent confirmation can overwrite published bytes

status: open · origin: 2026-09-23 firefox plan review · area: upload publication

`python/nexus/services/media_upload_sessions.py:465-486` derives the candidate
path solely from session/generation, verifies staging, then copies staging to
that shared path. staging remains writable through its signed capability.
a delayed concurrent confirmation can overwrite the candidate after another
confirmation publishes it. even without concurrency, copying after verification
does not prove the copied bytes were those measured. source-confirmed; not yet
reproduced live.

fix: reserve a fresh candidate path per confirmation, copy first, verify that
candidate, and publish that exact path. browser captures also require the
immutable intent digest. use existing reservations for losing/crashed candidates;
no additional lease system.

acceptance: a live delayed-copy/concurrent-confirmation case cannot change
published bytes; published size/digest describe the actual object. losing
candidates remain reclaimable through existing cleanup.
