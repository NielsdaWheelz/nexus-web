# embedded note control density needs a presentation decision

a note whose sole body is a resource embed has two semantic identities: the
containing authored occurrence and the displayed resource. their controls need
an explicit narrow-layout presentation without conflating graph authority.

the old density report named the removed `OutlineEditor`/`RowText` path. the
merged flat path is `apps/web/src/components/notes/NoteEditor.tsx`:
`resource_embed` portals `EmbeddedResource` into the containing field, where it
renders a read-only `ResourceOutlineRow`. its controls remain distinct from the
containing occurrence's chrome in `OutlineEditorRow.tsx`. the old width diagnosis
has no separately identified current flat-editor measurement.

functional embed ownership, detachment and history are qualified. that does not
settle whether the remaining control density meets the intended restrained
presentation. measure the current narrow layout before calling it a reproduced
regression or changing its owners.

resolve with an explicit presentation decision and a current narrow/touch
witness preserving both identities, content/actions, selection, focus, history
and the persistent native host. retain separate semantic owners even if their
visual controls are consolidated; do not repair density by reparenting the host,
negative margins or a guessed overlay.
