# raw reference projection uses a nonexistent schema root

at `d90ed1033`, private run `20261021-131016-a53791bba604`, typing `@` in an empty
canonical note crashes its pane (`TypeError: undefined.create`). the raw-query
layout effect in `apps/web/src/components/notes/NoteEditor.tsx` calls
`schema.nodes.doc.create`, while the canonical schema in
`apps/web/src/lib/notes/noteBody.ts` names its root `note_body_doc`.

use the schema's `topNodeType` in this projection. resolved when the unchanged
real offline reference journey types and restores the exact raw query without
publication or pane failure.
