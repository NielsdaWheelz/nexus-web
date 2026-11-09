# populated background temporary io

normal creation of 100,000 notes leaves approximately 100,000 accepted
`authored_text_reindex_job` jobs. claiming this backlog repeatedly spills about
25.27 mib of temporary data. this is existing indexing work, separate from finite
observation; the observation request/memory/cpu gates pass.

evidence: `.nexus-local/lab/20261109-133948-92224e73c855/artifacts/resource-observation.private.json`,
`measurements.samples` and `observed.start`; compare database counters at offsets
300 and 420 seconds. the corpus has 100,000 notes, eight actual yjs edits each,
1,800 accepted commands, 128 media and 1,000 note embeds. the complete run wrote
10.72 gib of temporary data; the 120-second hidden interval wrote 910.49 mib with
zero new application requests. no oom, restart or deadlock occurred.

canonical restore proof:
`.nexus-local/lab/20261109-142527-d77f910ac1b1/artifacts/` contains
`background-baseline.private.json`, `postgres-temporary-io.private.log` and
`observation-query-plans.private.json`. in 60 seconds without a browser, the
background supervisor completed 19 jobs (99,707 pending became 99,688), and wrote
exactly 19 temporary files / 503,521,280 bytes. each claim cycle wrote 26,501,120
bytes. slow-statement logs show the due-job `SELECT * ... ORDER BY ... LIMIT 1
FOR UPDATE SKIP LOCKED` taking 141–157 ms, followed by its claim update, at
`python/nexus/jobs/queue.py:205`. temporary-file deletion is logged under that
update; a future fix must obtain the exact claim plan before attributing its
internal sort. this is backlog processing, not empty-queue polling.

the exact observation plans are separate: scope revision sql processed 905 fact rows in
17.13 ms with zero temporary blocks; every media-batch statement also had zero
temporary blocks. shared-buffer reads are not a measurement of physical-device io.

impact: a large one-time import causes substantial queue-claim disk amplification
on the fixed 512 mib database. leave repair outside the observation cutover.

proposed investigation: obtain the claim plan on the retained populated backup;
test sorting/locking only the candidate's needed scalar fields, obtaining its full
payload from the existing update's `RETURNING *`. preserve exact priority/due/time/id
ordering, skip-locked behavior, heavy-capacity admission, expired-claim recovery,
execution fencing and transaction ownership. do not raise work memory or change
schema/infrastructure to conceal the query shape.

resolved when the same backlog/lock-contention cases choose and fence the same
jobs, claim temporary io is bounded, and a drained queue has negligible idle io.
