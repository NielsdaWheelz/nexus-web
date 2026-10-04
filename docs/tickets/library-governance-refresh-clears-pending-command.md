# library governance refresh clears a pending command

status: open, source-qualified; live reproduction pending · origin: 2026-10-04 simplification audit at `ef3f1d7f` · area: library governance web

`apps/web/src/lib/libraries/useLibraryMembers.ts:565-569` lets `ensureFresh` adopt pages through `apps/web/src/lib/libraries/governanceState.ts:233-261`, which unconditionally resets the command to idle. a nonabortable write can still be awaited at `useLibraryMembers.ts:750-770`. members-tab reactivation (`625-639`) and permission-related paging refresh (`1035-1040`) can reach this path, so fresh pre-settlement pages can reopen write admission while that command remains pending.

merged governance rewrite `2e7668a101b4f5808ec46bfc516b9ab156e2263f` (#512) retains this hazard: `useLibraryMembers.ts:423-445` publishes an ordinary authority refresh through `395-418`, setting `command` idle at `416`, while `runCommand` can still await the write at `541-549`. tab reactivation still calls `ensureFresh` at `473-478`. the modeled missing-member and lost-role-reply findings were resolved by #512; this separate command-admission item remains source-qualified only.

keep one live-visit command slot until its actual settlement and authoritative reconciliation; ordinary refresh must not clear it. preserve permission-loss handling, paging and writes blocked after unconfirmed reconciliation. first establish the mounted sequence with a held mutation and an intervening refresh.

acceptance: while the first write is held, tab reactivation and paging-triggered refresh cannot admit a second write or announce completion. releasing it settles/reconciles once; unmount suppresses late visit-local effects. no live behavior is claimed by this source record.
