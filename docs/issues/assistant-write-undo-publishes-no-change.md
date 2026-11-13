# assistant write undo does not refresh the lectern

status: open · area: lists / model tools

`undoAssistantWrite` (`apps/web/src/lib/assistantWrites.ts`) publishes `Notes`,
`Entries` and `AssistantWrites` after acknowledgement. undoing a
`nexus.queue.add` also removes a lectern item, but publishes no `Lectern` change.
callers are chat (`components/chat/AssistantTrust.tsx`), librarian settings
(`settings/librarian/Writes.tsx`) and connections (`lib/resourceGraph/links.ts`).
the mounted queue may retain the removed row until another read or refresh.

proposed fix: publish `Lectern` from the shared undo owner after the 204.

resolved when undoing a queued write from each caller removes its row from an
already mounted lectern without moving focus.
