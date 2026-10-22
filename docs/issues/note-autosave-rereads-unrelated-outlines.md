# note autosave rereads unrelated loaded views

status: open · origin: owner source audit, 2026-10-21; narrowed by the notes re-slice (#734) · area: web change publication and shared reads (`lib/api/changes.ts`, `lib/notes/texts.ts`)

problem: a text acknowledgement publishes a global topic, and every mounted view that
follows it rereads in full, whether or not it shows the edited note or page. since
#734 a plain body save publishes only `NoteBodies`, so outlines no longer reread on
it; but every mounted media pane, chat context, connections surface and search pane
still does. a title save, a creation, or a body save whose embeds moved a links lane
publishes `Notes`, and every mounted outline rereads its whole loaded prefix.

evidence (source at `2e154f053`; no request counts or latency measured):
- `apps/web/src/lib/notes/texts.ts:511-535`: the save acknowledgement publishes
  `NoteBodies`, or `Notes` too when the save is a title, a creation or moved a lane
  (`:530`).
- `NoteBodies` followers: `app/(authenticated)/media/[id]/MediaPaneBody.tsx:282-288`
  refreshes the annotation map; `components/chat/ChatContext.tsx:29-31`,
  `components/connections/ConnectionsSurface.tsx:49,56` and
  `app/(authenticated)/search/SearchPaneBody.tsx:87` put it in their stale token.
- `Notes` followers: every outline (`lib/resourceGraph/useResourceOutline.ts:73,82-84`),
  the daily outline (`lib/notes/useOutline.ts:70`), the notes index
  (`app/(authenticated)/notes/NotesPaneBody.tsx:97`) and workspace titles
  (`lib/workspace/presentations.tsx:143`).
- `lib/api/pagePrefix.ts:8-28,36-56` rereads the requested prefix sequentially from its
  first page on every stale change. read state is per hook
  (`lib/api/serverState.tsx:186-280`, stale refetch `:273-278`), so two mounted
  consumers of the same endpoint do not share a request.

impact: ordinary writing creates read traffic and projection work that grow with open
panes, disclosed branches and loaded pages, not with what changed.

fix: let the shared read owner consume the acknowledged resource changes, deduplicate
reads by account, resource and query, and invalidate only the affected adjacency or
collections. keep canonical ordering, version fences and stale-response protection; do
not replace them with component-specific cache mutations.

resolved when saving one loaded note or title updates every visible occurrence while
views that do not show it issue no reads, duplicate consumers share required reads,
and structural changes still refresh the affected loaded prefixes.
