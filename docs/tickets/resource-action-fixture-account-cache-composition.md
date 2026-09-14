status: open
origin: 2026-09-14 bounded workspace implementation; run `5b4c9766b2fb34c1`
area: browser proof composition

`ResourceActionRuntimeProvider` now requires the account reader cache. the podcast
fixture fails before its oracle with `Resource actions require the account reader
cache` (`apps/web/src/lib/actions/resourceActionRuntime.tsx:1554`). its actual cache
provider is restored; replay is pending.

other fixtures instantiate this provider without a cache, including
`canonicalResourceMenuNexusPlayer`, `ContextualActionMenu`, `chatAdmission`,
`AssistantMessage`, `ConversationContextRefsSurface`, `ImportsWorkspace`, and
`CollectionRow` browser proofs. audit all direct fixture consumers. compose the
existing account cache with its committed limits; do not mock the required owner.

acceptance: every affected fixture reaches its original behavioral oracle and
passes; required sensitivity replays attest the changed proof bytes.

2026-09-14 follow-up: all 16 direct fixtures now compose the real account cache.
run `4b3cdec89febcffb` then reached the actual browser player and failed at
`mediaSession.ts:94`: its media-session adapter also requires the account artwork
reader. all 16 mount that player; the existing artwork provider and committed
limits are now composed at each fixture. original behavioral assertions remain
unchanged; all 16 focused owners pass in `703cd32497dbaf5b`. root reviewed
the exact three registered owner deltas; their unchanged product-fault replays
are pending because the original base lacks the required provider modules.

all three unchanged registered faults now pass at `bec1fbf403`: imports workspace
`5097810c40084c1b`, imports pane `6d7ab9ca53ad90d9`, chat admission
`23dd9b3e9b268dab`. parent owns the separate podcast/strict-mode replay and final
combined disposition.
