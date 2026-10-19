# the reader's empty-note hint promises a backspace deletion phones do not perform

status: open · origin: resource references re-slice port onto main, 2026-10-19 · area: reader selection composer (web)

an emptied existing highlight note in the reader's composer (`media/[id]/SelectionDock.tsx`) reads
"backspace deletes this note and its links. the highlight stays." beside "delete empty note". since
#689, `NoteEditor` ignores empty-note Backspace on any coarse pointer (soft keyboards report a held
key as fresh presses), so on a phone the key does nothing and only the button deletes. the refs
harness journey `notes/N6.highlight-note-mobile-sheet` asserts the phone's Backspace keeps the
note and the button removes it.

impact: phone readers are told a key deletes the note; it does not.

resolved when: the hint names only what the pointer can do (the button on coarse pointers).
