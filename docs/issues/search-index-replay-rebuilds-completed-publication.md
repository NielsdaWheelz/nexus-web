# index replay rebuilds completed publication

status: open; source-confirmed, crash-window reproduction pending.
origin: 2026-10-21 progressive search specification.

`python/nexus/services/content_indexing.py:544-561` prepares every current claimed
job by setting indexing, without checking whether its revision already completed.
the publisher replaces spans/chunks and reruns completion effects (`:185-248`).
note jobs likewise republish an unchanged body and enqueue discovery again
(`python/nexus/services/note_indexing.py:78-97`).

impact: a crash after publication commits but before queue acknowledgement can
remint passage ids and repeat effects. no-text/ocr-required outcomes also replay,
changing timestamps and repeating applicable parent-thread/discovery work.

reproduce in an isolated runtime: stop a worker after publication commit but
before acknowledgement; reclaim and run the same revision. compare materialized
ids, index timestamps and downstream work before/after replay.

resolved when current ready/current-model, no-text and ocr-required outcomes are
recognized before preparation changes state. completion effects must share the
publication transaction; replay must be a no-op. a text-only publication must
instead resume embeddings against its existing ids.
