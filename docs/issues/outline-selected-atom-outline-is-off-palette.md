# selected outline atoms keep the dependency's blue outline

source finding at `fcd6843db` on 2026-11-15; not a rendered atom-selection case.
the imported prosemirror stylesheet gives selected atoms a 2px `#8cf` outline.
`apps/web/src/components/notes/NoteEditor.module.css` removes the outline only
from a selected direct outline row, leaving nested atom selections on the
stock paint.

impact: node selection can introduce an unrelated blue into the app's rooms.

resolved when: nested selected atoms use the canonical selection/focus paint
at the note-editor owner, preserving a visible keyboard selection rather than
removing its indicator.
