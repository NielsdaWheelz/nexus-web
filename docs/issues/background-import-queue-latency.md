# background import queue latency

a burst of note indexing can leave a newly accepted source import queued beyond
120 seconds. source ingest and note reindex share the background lane and default
priority 100 (`python/nexus/jobs/registry.py:109`, `python/nexus/jobs/queue.py:132`);
`claim_next_job` orders by priority, due time and creation (`python/nexus/jobs/queue.py:206`).

in isolated production lab `20261020-081351-decfa87587a0`, the partial-outline
fixture created 100 notes, then upload `de673ae9-b48c-4e89-a441-d85c2661b812`
published fresh media `01a159ec-54e4-70b4-a9de-ee07ea32f71c` at 15:27:02 utc.
118 reader requests returned `409 E_MEDIA_NOT_READY` over 120 seconds. public
import/history reads still showed `Validate / Queued / Queue`, with no started or
failed source event. the worker kept completing note reindex jobs about every
3.3 seconds. the annotation behavior under test was never reached.

qualification should isolate this bulk fixture or run it after import-dependent
cases; this is not evidence of an annotation regression. independently assess
whether interactive import latency under an ordinary bulk note write needs a
queue policy change. resolution requires measured bounded source admission under
that workload, or an explicit accepted latency contract. do not bypass ingestion.

post-merge smoke `20261020-085100-2e5b07bef35b` also failed before its
companion-focus behavior, after only the touch and cold-link fixtures. upload
`06c305d6-1d1c-405e-9115-14e5e53c3295` created fresh media
`01a15a03-bce3-7697-abc4-48d9f24d0d20`. the trace contains 24 reader
`E_MEDIA_NOT_READY` responses, 15:52:37.208–15:53:00.629 utc, each 8–18 ms.
then network observations cease until the reported 120-second poll timeout
ends a 4.9-minute case. worker logs likewise have no later progress after a
15:53:00.652 catalog-unavailable discovery settlement; no source start/failure
is recorded. this does NOT establish small-burst queue starvation: the long
observation gap leaves host/runtime scheduling as an unresolved alternative.
the unchanged companion witness passed in 6.4 seconds when first in fresh
runtime `20261020-090719-3cff8aa446c9`, with process-scoped idle-sleep
prevention. the earlier scheduling gap remains unexplained; no focus defect
was observed.

local-first composition `78505bfb1`, run `20261026-050117-e8cc22e5435d`,
passes firefox and two held-writing controls, then fails the reader hook's shared
50-second upload budget: epub ingestion completes while note indexing and
connection discovery settle; the following pdf still returns
`409 E_MEDIA_NOT_READY` after 17 polls. no annotation case runs. keep the reader
qualification in a fresh runtime, with its actual upload path and unchanged
deadlines. this observation adds no import-latency guarantee or queue-policy fix.
