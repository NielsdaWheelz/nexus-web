# chat write undo can commit before its completion stamp

status: open, transaction fix staged; interruption proof pending · origin: 2026-09-25 latest-model migration review · area: chat and generation write undo

## problem and evidence

before this change, `python/nexus/services/agent_tools/writes.py` stamped the
chat tool call and authorship after target owners had committed note/highlight
deletion, media unfiling or queue removal. a process death could leave an
absent target with no completed undo stamp. the shared reversal now uses
in-transaction target commands and one final commit. the new background
generation position undo uses that same reversal owner and stamps its position
and authorship in the same transaction.

`reverted_at = null` means no completed undo was recorded. it does not prove
the target still exists or that undo was never attempted. the model-history
migration copies this fact without inferring a timestamp from target absence;
manual deletion is indistinguishable from a partial undo.

## prerequisite and resolution

prove a forced interruption between each reversal and final stamp leaves either
all effects and stamps committed or none, for both chat and background positions.
prove retry and already-absent-target behavior, then delete this ticket.
