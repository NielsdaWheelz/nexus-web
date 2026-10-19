# evidence note editor survives external detachment

status: open · origin: 2026-10-15 selection-composer integration review · area: reader / evidence editor

source inspection: `apps/web/src/app/(authenticated)/media/[id]/evidence/EvidenceRow.tsx:144`
(`NoteEditorHost`) keeps its loaded
`note` when the parent’s `noteBlockId` changes to null. its read effect returns
without clearing that value; `apps/web/src/components/notes/AnnotationNoteEditor.tsx:56` retains its note id and
`attached` state. own-editor detach sets the host value to null, but detaching
through another surface does not. global note deletion is repaired separately.

the host can therefore keep showing/editing a standalone note as if it were still
attached. the normal note writer addresses the note, so edits may still save.
this external-detach journey is inferred from the source, not qualified live.

reproduce: open a highlight’s evidence note editor; detach its note through a
second surface; refresh the document map; inspect the retained editor and type.

fix at the evidence host’s attachment owner: settle the editor when its known
attachment disappears, while preserving the canonical note/draft policy and
keeping ordinary same-id save acknowledgements mounted.

acceptance: external detach removes the misleading attached editor; the note
survives, local text follows the existing note-owner policy, and same-id autosave
acknowledgements preserve focus/history.
