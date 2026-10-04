# chat write undo can commit before its completion stamp

status: open; broader interruption proof pending · origin: 2026-09-25 latest-model migration review · area: chat and generation write undo

2026-10-03: `617baf70e` commits the single completed-write receipt/undo contract
used by chat and account effects. ten actual postgres/tool-owner cases pass,
including SIGKILL after note reversal before stamps/commit, fresh-session rollback,
retry, repeat and already-absent-target handling. the restored `0241→0256` proof
also inspects and undoes original writes through the authenticated account api.
receipts: `metadata-effect-owner-undo-green.json` and
`metadata-restored-cutover.receipt.json` in
`/private/tmp/nexus-metadata-release-uy48cjy2/`. these do not prove each resource
reversal or background workflow interruption; this ticket stays open for that
remaining scope.

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
