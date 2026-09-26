# chat write undo can commit before its completion stamp

status: open · origin: 2026-09-25 latest-model migration review · area: chat write undo

## problem and evidence

`python/nexus/services/agent_tools/writes.py:446-457` stamps the chat tool
call and durable authorship only after reverting every target. note deletion,
highlight deletion, media unfiling, and queue removal each commit inside their
own owner before that stamp. a process death in between leaves an absent
target with no recorded completed undo. the edge branch's early commit was
removed in this cutover, but the other owner boundaries remain.

`reverted_at = null` means no completed undo was recorded. it does not prove
the target still exists or that undo was never attempted. the model-history
migration copies this fact without inferring a timestamp from target absence;
manual deletion is indistinguishable from a partial undo.

## prerequisite and resolution

make each target owner expose an in-transaction reversal and commit the full
undo and authorship stamp once, with the owner locks and retries intact; keep
external queue effects explicit if they cannot join that transaction. prove a
forced interruption between each reversal and final stamp leaves either all
effects and stamps committed or none, and prove retry/absent-target behavior.
