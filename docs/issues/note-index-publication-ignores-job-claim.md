# note index publication ignores its job claim

status: open; source-confirmed, reclaimed-attempt runtime check pending.
origin: 2026-10-21 progressive search specification.

`python/nexus/services/note_indexing.py:51-95` accepts a job execution context
but never checks its claim before publishing. the final transaction checks only
that the note body still equals the body embedded by this attempt. the queue
can reclaim an expired attempt (`jobs/queue.py:218-247`); its existing
`lock_running_job_claim` (`queue.py:408`) distinguishes the current execution.

impact: a superseded execution with an unchanged body can still replace
published chunks and evidence-span identities. splitting lexical publication
from embedding completion also requires fencing both commits against this race.

reproduce in an isolated runtime: pause a note job after embedding, reclaim its
claim, then resume the old execution. it must publish nothing. use the existing
queue claim plus the note's publication revision under its row lock; do not
invent a second lease owner.

resolved when stale attempts cannot alter text, passage identities, embeddings,
readiness, or downstream publication side effects, including an edit away from
and back to the same body while an earlier attempt is running.
