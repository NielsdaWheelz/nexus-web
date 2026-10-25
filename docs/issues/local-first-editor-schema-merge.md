# automatic rich text merge must preserve the single block contract

qualification gap for the proposed local-first editor, not a demonstrated defect
in the present versioned editor: independently valid edits can combine into a
shape that does not satisfy the editor schema.

evidence: `apps/web/src/lib/notes/noteBody.ts:57` requires exactly one `block_body`;
the grammar includes paragraph, code and object-embed bodies. each body editor
and outline command currently assumes that shape (`components/notes/NoteEditor.tsx:5-12`
under web source). a generic crdt/editor binding does not prove the invariant.

resolved when the selected representation and binding demonstrate concurrent
block-type replacement, initialization, composition and split/join without
silently deleting writing to repair the schema. test actual nexus node/mark and
reference semantics; a plain-text merge demonstration is insufficient.

owner decision: retain exactly one block. the specification selects a permanent
`body` element with presentation attributes and inline atoms; initialization is
excluded from text undo. also remove `schemas/notes.py`'s 200-character title
storage fence: concurrent valid title edits may exceed it. no merge repair may
truncate title or body content.
