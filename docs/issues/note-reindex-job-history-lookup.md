# note writes inspect completed reindex-job history

`python/nexus/services/note_indexing.py:enqueue_note_reindex` asks
`python/nexus/jobs/queue.py:jobs_for_payload` for every status, then uses only
pending/failed jobs. the query matches `payload @> ...` across same-kind retained
history; the schema has no matching payload index. creating or editing a note
therefore has a history-sensitive lookup unrelated to its body size.

desktop writing qualification exposed slowing fixture construction. this lookup's
wall-time contribution is UNMEASURED; concurrent host work is a confounder, and no
writing-latency budget has failed. do not attribute the slowdown to this query.

first narrow the caller through the existing statuses contract, then measure its
actual plan with retained history. resolve when enqueueing preserves unclaimed-job
semantics and its lookup cost is bounded by relevant live work at the required load.
