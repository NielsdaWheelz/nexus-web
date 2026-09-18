# note body text projections disagree

status: open · origin: 2026-09-17 passage integration, base 1bee992eb · area: note bodies

`python/nexus/services/note_bodies.py:52-83` includes hard breaks and object
labels and trims each line when projecting a valid note body into stored text.
`apps/web/src/lib/notes/prosemirror/schema.ts:285-293` instead uses
`body.textContent.trim()`. its strict `decodeNoteBodyValue` rejects the server's
own valid projection with `bodyText must match bodyPmJson`.

temporary cross-language proof accepted a plain paragraph and reproduced three
rejections: a paragraph with a hard break, an inline object label, and a code
block with trailing spaces before a newline. all inputs passed the backend's
`validate_note_body_pm_json`. receipt:
`/tmp/nexus-cleanup.3vgYE2/note-body-projection-gap.json`.

give the editor's body-text projection the same canonical semantics as persistence
and pulse offsets. reuse one frontend projection in editing and transport
decoding; do not relax the consistency check or add a fallback.

acceptance: each valid note survives save, server read, strict client decode,
and editor range positioning with identical raw codepoint offsets; labels,
hard breaks, unicode, and line trimming preserve that identity.
