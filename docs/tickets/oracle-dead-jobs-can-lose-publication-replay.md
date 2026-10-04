# oracle dead jobs can lose publication replay

status: open, source-qualified; live reproduction not run · origin: 2026-10-04 independent oracle audit at `2a0b31369132fefbd913f317dffe659ebc8cb98d` · area: oracle generation recovery

`python/nexus/jobs/registry.py:224-231` gives oracle no dead-letter projection or dead-row retention. the registry declares one attempt, but `services/oracle.py:271-278` actually uses `jobs/queue.py:211-238`'s three-attempt default. after the stored budget is exhausted, a handler defect or expired lease becomes dead (`queue.py:423-447,663-700`; `jobs/worker.py:161-167,313-329,347-350`) without settling the reading. `tasks/oracle_reading.py:35-39` deliberately preserves uncertain generation and publication defects for recovery.

the reading can stay pending while its queue payload owns the `Completed` publication result or unresolved generation journal (`services/oracle.py:1074-1093`; `services/durable_step_journal.py:88-110,128-136`). `tasks/prune_background_jobs.py:16-35` does not exclude oracle; `queue.py:965-1004` deletes the dead row after the configured retention, default 30 days (`config.py:284-286`). this removes the existing requeue/replay checkpoint. separate generation ledgers retain terminals; complete prose irrecoverability and production occurrence are not established.

retain dead oracle jobs through the existing registry policy and define operator-owned recovery for their nonterminal readings. make the declared and stored attempt policy agree. do not fabricate a reading failure before a known generation terminal or resend an uncertain generation.

acceptance: a legitimately exhausted or interrupted oracle job leaves its unresolved reading and replay payload discoverable; a backdated dead job survives native pruning and can be repaired/requeued through the existing ownership rules. prerequisite: isolated native job/journal fixtures, with no provider dispatch needed.
