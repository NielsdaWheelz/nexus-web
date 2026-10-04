# the activity outbox batches rows in creation order, not occurrence order

status: open · origin: 2026-09-28, size/consumption-stats reauthoring (live pin notes) · area: consumption activity / web outbox · p3

`outbox.nextBatch` (`apps/web/src/lib/consumption/activityOutbox.ts:131`) walks
the `accountStateCreatedAt` index, so a batch lists rows by `createdAt`. the
server rejects a batch whose spans are not ordered by `occurredAt` and
non-overlapping (`python/nexus/services/consumption/activity.py:66`, 400
`E_INVALID_REQUEST`), and the runtime then marks every row of the batch
`Failed` (`activityRuntime.ts`, `outbox.fail`). two tabs reading the same work
on one device can write rows whose creation order differs from their occurrence
order (a lane idles out in one tab after the other tab closed a later span).
the whole batch fails as a defect, and Retry rebuilds the same batch.

observed by the branch's live pin suite (not asserted). the shape predates the
reauthoring.

impact: lost reading time for that work and device; rare, since it needs two
active tabs on one work.

fix: `nextBatch` orders the collected rows by `occurredAt` and ends the batch
before a row that starts before the previous row ends; the frozen upload body
and captureKey semantics do not change.

acceptance: two tabs on one work, spans written out of occurrence order, all
upload with 204 and none is `Failed`.
