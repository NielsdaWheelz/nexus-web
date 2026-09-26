# cancelling uncertain codex work can requeue without settlement

status: local fix; live worker proof pending · origin: 2026-09-25 chat recovery source review · area: chat cancellation

at `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`,
`llm_execution.py:819-843` refuses an uncertain codex dispatch before executing
the generation. `chat_run_worker.py:311-314` directly finalizes cancellation
only when no generation state exists. an uncertain generation therefore
cannot reach that cancellation path.

`chat_runs.py:1032-1042` records cancellation and requeues a dead job.
`tasks/chat_run.py:63-69` automatically requeues it again after exhaustion
while cancellation remains requested; `jobs/queue.py:709` resets attempts to
zero. these paths can repeat without settling the uncertain run. this is a
source-proven control-flow defect; cancellation was not exercised on production.

prerequisite: define cancellation ownership for an uncertain external dispatch.
implement bounded reconciliation or an explicit unresolved cancellation state
at the generation owner, preserving uncertainty and already committed effects.
do not blindly redispatch, pretend external work stopped, or automatically
renew the attempt budget indefinitely.

acceptance: cancelling an uncertain codex run reaches a truthful settled or
explicitly unresolved state with no repeated provider dispatch and no automatic
dead-to-pending loop. cover both a received host rejection and a lost terminal.
