# native binding without an observed turn

problem: a worker can stop after committing its fresh native thread identity but
before the native turn appears. an idle thread alone does not prove that the old
submission writer ended: a paused worker or interrupted database connection can
lose its lease and later attempt its one submission.

impact: generation recovery holds the existing job and account queue when the
bound thread has no observable terminal turn. it neither resubmits nor declares
remote completion. this deliberately trades automatic recovery for correct
ordering; live repair is required for this narrow pre-submission crash window or
unavailable native control.

evidence: `services/generation/native_execution.py` requires an observed terminal
turn; `generation/codex.py` commits the binding before `run_native`. the queue's
heartbeat permits expired-lease recovery while a previous process may remain
alive. `TransientNative` does not provide cross-process submission fencing.

repair: establish that the original writer cannot submit, reconcile or retire its
exact native thread, record finality, then retry the existing held job through the
existing operator repair owner. never clear the binding or assert finality from a
timeout. automatic recovery requires a provider-owned writer-retirement guarantee
qualified against ephemeral threads; no new replay journal is proposed.

resolved when actual pre-submit process loss and stale-writer resumption prove
safe automatic finality without reconstructing prompts or duplicating inference.
