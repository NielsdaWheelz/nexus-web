# untouched daily draft cannot be opened in another pane

the blank daily draft exists only in its owning pane's local outline. opening its
resource link in a separate note pane requests a server note that does not exist
until the first write. the new pane can show an unavailable note.

evidence: `apps/web/src/lib/notes/useOutline.ts:491` creates the local draft.
`pendingRoot` at line 586 suppresses root reads for queued
creations in `carried`; an untouched, unqueued draft is absent from that lane.
`apps/web/src/lib/notes/outline.ts:184` gives this local note its normal route.
queued creation reads are handled; the separate unqueued navigation gap remains
source-traced and has not been browser-reproduced in this change.

decide the navigation contract for an unqueued draft without materializing on
mere opening or adding a parallel draft lifecycle. resolved when opening an
untouched daily draft in another pane keeps its identity and body available,
with no premature server read and no write until an explicit edit or creation.
