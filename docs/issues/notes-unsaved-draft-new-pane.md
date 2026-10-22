# untouched daily draft cannot be opened in another pane

the blank daily draft exists only in its owning pane's local outline. opening its
resource link in a separate note pane requests a server note that does not exist
until the first write. the new pane can show an unavailable note.

evidence (main `c0063b28e`): `apps/web/src/lib/notes/useOutline.ts:129-200`
(`showDraft`) opens the local draft. `pendingRoot` (`:322-325`) suppresses the root
read only when the session already holds that note's own outline; an untouched draft
has none, so a note pane opened on it reads it. `apps/web/src/lib/notes/outline.ts:259-272` gives this local note its
normal route. reproduced 2026-10-21 by the notes re-slice harness (pages/P23,
strengthened), on main and on P1 (#734): the second pane's read of the unsaved note
answers 404. the dropped web engine (P2, `88acbbf1e`) fixed it by projecting the draft
as a local intent in the new pane's graph; the owner's durable-writing work may
supersede this.

decide the navigation contract for an unqueued draft without materializing on
mere opening or adding a parallel draft lifecycle. resolved when opening an
untouched daily draft in another pane keeps its identity and body available,
with no premature server read and no write until an explicit edit or creation.
