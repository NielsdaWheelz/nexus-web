# assistant write undo publishes no change topic

status: open · origin: 2026-10-10 rebase of the collection-revision cut onto model tools (#561) · area: lists / model tools

the cut's contract (architecture §8.12, `lib/api/changes.ts`) is that the tab's
own writes reread every mounted list they affect. the one undo,
`undoAssistantWrite` (`apps/web/src/lib/assistantWrites.ts`), is a tab's own
write from the chat card (`components/chat/AssistantTrust.tsx`), settings
(`settings/account/AssistantWrites.tsx`) and connections
(`lib/resourceGraph/links.ts`), and publishes nothing. undoing a
`nexus.library.add` removes a library entry (Entries) and undoing a
`nexus.queue.add` removes a lectern item (`Lectern`), so a mounted library
pane or queue view in the same tab keeps the row until a pane return, Refresh
or another publish. not a regression: on main before the cut the old undo
published to no bus either. neither harness checks a mounted list after an
undo (tools T3/T6 check targets by sql).

proposed fix: `undoAssistantWrite` publishes `Entries` and `Lectern` after the
204 (or by the call's created ref kind, if the caller passes it); the chat card
publishes `Lectern` after a `nexus.queue.add` too.

acceptance: a journey with a library pane mounted beside the chat: undo of a
library.add drops the row from the pane without focus.
