# note citation pulses count untrimmed editor text

status: open · origin: 2026-09-17 cleanup audit, 8cbfc9580 · area: notes · oi-164

`python/nexus/services/note_bodies.py:79` trims the stored text projection.
`services/resource_graph/resolve.py:663-680` creates whole-note citation offsets
against that projection. `apps/web/src/components/notes/NoteBodyEditor.tsx:916-945`
instead counts the original editor text from zero.

reproduction: note text `  target` stores `target`; citation range `[0:6]`
therefore decorates `  targ`. per-line whitespace trimming also needs mapping.

give the note text projection and its editor positions one explicit contract;
project canonical offsets into editor positions without rewriting stored notes.
preserve hard breaks, inline object labels, and codepoint-to-utf16 conversion.

acceptance: create notes with leading/trailing whitespace, multiline text,
inline objects, and astral characters; activate their citation ranges in a real
editor and verify the intended text is decorated. run `./scripts/test`.
