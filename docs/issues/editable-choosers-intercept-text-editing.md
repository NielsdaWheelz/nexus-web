# editable choosers intercept text editing

status: open
origin: 2026-10-16 shared control source audit
area: web / author, people and editor reference search

the chat destination picker was fixed by the chat re-slice
(`chat/ConversationDestinationOverlay.tsx`: composition, modifiers and home/end stay the
field's; only plain arrows move the choice). under `apps/web/src/components/`,
`contributors/AuthorSearchField.tsx:145-163` still maps home/end and arrows to option
movement and prevents default without checking modifiers.
`users/PeopleSearch.tsx:80-95` passes only `event.key` into the same class of
roving logic (`lib/ui/rovingIndex.ts:22-32`). caret/selection shortcuts can
move options instead of editing search. source-confirmed; platform repro
pending. the library instance has an
[existing ticket](library-picker-intercepts-modified-text-editing-keys.md).

the 2026-10-22 source review at `832d8e4b8` also finds the same ordering error
in editor reference search: `notes/NoteEditor.tsx:631-650` prevents default for
enter/up/down before checking modifiers; `notes/ReferenceRowEditor.tsx:278-281`
consumes up/down before its `bare` check. modified arrows are swallowed while
reference search is active. these paths are under `apps/web/src/components/`;
physical keyboard reproduction remains unrun.

prerequisites: none. editable inputs retain native home/end, modified arrows
and selection shortcuts; list navigation gets only its intended unmodified
keys. share the input contract rather than widening the noneditable roving
helper's responsibility.

acceptance: normal caret movement and modified selection work in all affected
inputs and reference editors; unmodified up/down still navigate options and
enter selects only the current target. verify on macos and the supported touch
shell.
