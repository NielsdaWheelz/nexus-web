# old verification can reject a newer upload generation

status: open · origin: 2026-09-23 firefox plan review · area: upload publication

`python/nexus/services/media_upload_sessions.py:489-491,670-701` records terminal
verification failure without the inspected generation. while verification runs
outside the transaction, retry can advance the session; the old failure then
rejects the new generation and records that newer generation in its event.
source-confirmed; not yet reproduced live.

fix: pass the inspected generation to the failure writer; under the session
lock, mutate only an unpublished session whose current generation still matches.
apply the same generation condition to every verification outcome.

acceptance: hold a failing confirmation, advance the generation, then release
the old result. the newer generation remains usable and its history is not
attributed the old failure; published sessions cannot be rejected.
