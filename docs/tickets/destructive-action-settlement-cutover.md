# delete the lost-response destructive-action settlement protocol

status: open · origin: 2026-09-17 slop sweep (claude session) · area: web
resource actions · oi-156

`apps/web/src/lib/actions/destructiveActionSettlement.ts` disambiguates a delete
whose response was lost to `E_NETWORK` / `E_UPSTREAM` / `E_UPSTREAM_TIMEOUT`
(:37-42) by issuing a second retried POST to
`/api/resource-items/action-snapshots/resolve` as a commit witness, retaining
the ref through the cache barrier
(`resourceActionRuntime.tsx:1301-1317`) and publishing a synthetic domain
projection event when the witness says the delete landed. it serves three delete
intents (`RemoveMedia`, `DeleteLibrary`, `DeleteConversation` at
`resourceActionRuntime.tsx:763-811`) plus the mounted deletes, about 200 lines.
no docs/modules page and no deploy invariant names it.

the owner has approved deleting it as one cutover. a lost delete response then
leaves the row on screen until the next refresh; nothing durable is at stake for
a single user with live repair.

fix: delete `settleDestructiveAction`, `observeCanonicalResourceMissing`,
`isAmbiguousDestructiveActionError`, `unconfirmedDestructiveActionFeedback`,
`publishObservedDestructiveActionCommit`, `DestructiveActionSettlement`,
`CachedDestructiveActionObservation`, `reconcileUnconfirmedDeletionSubject`,
`finalizeDestructiveActionSettlement`, `settleMountedDeletionCommand`, the
`ObservedMissing` arm of `settleDeletedMessageConversation`,
`executeDestructiveMountedMutation`, `DestructiveMountedMutationOutcome` and
`DestructiveCommittingMountedActionIntentBase.settleDeletionCommand`
(`mountedActionHandoff.ts:19-23`), together with their consumers in
`lib/chat/messageActionIntent.ts`, `lib/highlights/actionIntent.ts`,
`lib/notes/actionIntents.ts`, `components/chat/MessageRow.tsx`,
`PagePaneBody.tsx:293` and `MediaPaneBody.tsx:6113`. repoint the four mounted
delete owners at `executeCommittingMountedMutation`-shaped code and let a failed
delete surface its `ApiError` through the existing `dispatchErrorContent` HUD
(`resourceActionRuntime.tsx:1650-1658`).

prerequisite: none — the decision is made. do it as one cutover; a partial cut
leaves the mounted path calling a protocol half-deleted.

acceptance: no `resolve` witness POST remains in the web client, deleting a
media item, a library, a conversation and each mounted subject still settles its
pane on success, and a forced failure shows the error HUD instead of a silent
retry.
