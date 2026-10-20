# note embeds repeat control gutters

a note whose sole body is an object embed renders a second outline inside the
note's already narrowed body cell. both the containing note and the embedded
resource reserve opening, disclosure and action space.

evidence: `apps/web/src/components/notes/OutlineEditor.tsx` supplies `RowText`
inside `ResourceOutlineRow`'s body; `NoteEditor.tsx` owns the noneditable
`object_embed` nodeview and portals `EmbeddedResource` into it. the note schema
in `lib/notes/noteBody.ts` permits exactly one body block.

impact: narrow embedded resources have less content width than ordinary disclosed
children. moving the note editor between header and tail would remount it;
spanning its existing cell beneath the controls adds an empty 24px/44px header.
both are poor density fixes.

resolved when an explicit single-row presentation combines the containing note's
occurrence controls with the embedded resource's content/actions while preserving
their identities, editing/selection, focus, history and native nodeview ownership.
this requires an interaction decision, not negative margins or an overlay.
