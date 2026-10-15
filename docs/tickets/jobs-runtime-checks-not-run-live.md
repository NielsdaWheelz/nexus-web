# jobs runtime checks the reauthor never ran live

status: open · origin: 2026-10-10 jobs runtime reauthor (review of design §15) · area: jobs / verification

the reauthor was verified on an isolated stack (real cgroup-bounded children,
both lanes, the web app). these design §15 checks had no journey there, so they
rest on reading the code and on the queue sql smoke:

- a media reindex child killed by the OOM killer records `IndexFailed`
  terminal `E_RESOURCE_LIMIT` (no OOM fixture for the index child; the ingest
  OOM ran).
- one prune run deletes at most `BACKGROUND_JOB_PRUNE_BATCH_SIZE` (100) rows
  (the run seeded two).
- a requeued dead `media_unit_build` publishes its head under the new
  execution (`tasks/media_unit_build.py` fence).
- RepairSearch requeues a dead search index as the same job, `pending`, fresh
  budget (the source repair ran).
- a teardown that fails five times over hours goes dead and voids its intent
  (`jobs/dead_letters.media_teardown`).

the committed-success branch of `source_publication.on_failure` ran only
through a lever (the attempt's success written by sql while its child was held,
then the child SIGKILLed); its product producer, a parent x thread completing a
running x-post child attempt (`media_source_ingest.complete_x_post_snapshot_attempt`),
had no fixture. the superseded branch ran through a product path (the media
deleted, torn down on a second background worker, then the child SIGKILLed).

2026-10-13 metadata qualification ordinarily admitted `enrich_metadata` jobs
with the two-attempt budget and exercised actual death/publication on attempt two.
that former missing fixture is resolved. it also proved search-repair readiness,
replay and independent offers; this does not establish the dead-index requeue
and fresh-budget check above. [receipt](../metadata-imports-verification.md).

acceptance: each check above observed once on a real stack (a journey, or a
recorded manual run), or the behaviour it guards removed.
