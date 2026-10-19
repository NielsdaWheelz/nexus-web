# untouched daily draft cannot be opened in another pane

the blank daily draft exists only in its owning pane's local outline. opening its
resource link in a separate note pane requests a server note that does not exist
until the first write. the new pane can show an unavailable note.

evidence: `apps/web/src/lib/notes/useOutline.ts:311–318` creates the local draft;
`loadVisibleOutline` at lines 373–385 recognizes the current pane's draft or a
queued creation, not an unqueued draft owned by another pane. the shared row's
resource link is rendered in `ResourceOutlineRow.tsx:171`. source-traced existing
navigation gap; not browser-reproduced.

decide the navigation contract for an unqueued draft without materializing on
mere opening or adding a parallel draft lifecycle. resolved when opening an
untouched daily draft in another pane keeps its identity and body available,
with no premature server read and no write until an explicit edit or creation.
