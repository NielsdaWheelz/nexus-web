# failed fork switch can restore stale live text

status: deferred · origin: 2026-10-04 source audit · area: chat / web

`apps/web/src/components/chat/useConversation.ts:1158–1240` snapshots visible messages before an optimistic leaf switch and restores that capture after a failed active-path request. while branch a is hidden, `apps/web/src/components/chat/useChatRunTail.ts:475–488` advances its folded sequence before skipping off-path text/tool publication. if a live update to a arrives during a failed switch to sibling b, restoring the old capture can show stale partial text. terminal reconciliation at `useChatRunTail.ts:400–436` merges only while a is visible; if it finishes before the switch fails, the tail ends and the rollback can restore a stale pending a until another observation. `python/nexus/services/conversation_branches.py:160–188,265–289` admits real pending leaves and includes their paths. this is a source-qualified risk, not a mounted reproduction or durable data-loss claim.

first prove one native-valid two-branch temporal sequence with a pending run, off-path update, terminal readback and failed switch delivered last. then restore the current authoritative a projection at the owning read/reducer boundary without redispatching generation; keep successful switching, accepted stop state, stream sequence and terminal reconciliation behavior.
