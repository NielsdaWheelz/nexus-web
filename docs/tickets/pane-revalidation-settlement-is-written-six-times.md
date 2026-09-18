# six panes each write the same revalidation settlement protocol

status: open · origin: 2026-09-17 slop sweep (claude session) · area: web panes
· oi-155

`rg -ln 'removeAbortListener' apps/web/src` returns six pane bodies —
`PodcastsPaneBody`, `PodcastDetailPaneBody`, `LibrariesPaneBody`,
`LibraryPaneBody`, `AuthorPaneBody` and `ConversationsPaneBody` — and each
carries the same shape: an interface of `{nonce|version|serial, sourceKey?,
resolve, reject, removeAbortListener}`, a `pendingXRef`, a `completedXRef`, a
`rejectPendingX` callback, a `revalidateX` that returns a new promise and
installs an abort listener, and a `useLayoutEffect` matching the completed nonce
to `resolve()`. about 500 lines of copy.

the protocol is load-bearing and must not be collapsed to an immediate resolve:
`PaneShell.tsx:386-425` awaits `publication.execute` and uses the resolved
`PaneRefreshResult` kind (`panePublications.ts:71-75`:
Complete|Partial|Failed|ObservationLost) for the settled announcement, and
disables the refresh action while refreshing (`PaneShell.tsx:864`). in
`PodcastsPaneBody.tsx:741-772` the rejection is exactly what turns a failed
re-fetch into `{kind:"Failed"}`, so resolving early would announce "refreshed"
over a failure.

fix: extract `useRevalidationSettlement()` into `apps/web/src/lib/panes/`
returning `{ revalidate(signal), settle(nonce), reject(error), fallback }`, and
call it from all six panes. it keeps the Failed/Partial arms and the abort
restore while deleting six copies of the interface, the two refs, the reject
callback, the promise/abort wrapper and the layout effect. preserve the
`PaneShell` `publication.execute` contract exactly.

prerequisite: none; scheduled as its own PR rather than inside a slice.

acceptance: one settlement implementation in `lib/panes`, six panes using it,
and a live browser check of pane refresh and its error path — a failed re-fetch
must still announce failure and re-enable the refresh action.
