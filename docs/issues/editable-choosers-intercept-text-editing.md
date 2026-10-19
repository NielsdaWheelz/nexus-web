# editable choosers intercept text editing

status: open
origin: 2026-10-16 shared control source audit
area: web / author, people and chat destination search

under `apps/web/src/components/`, `contributors/AuthorSearchField.tsx:145-163`
and `chat/ConversationDestinationOverlay.tsx:105-124` map home/end and arrows
to option movement and prevent default without checking modifiers.
`users/PeopleSearch.tsx:80-95` passes only `event.key` into the same class of
roving logic (`lib/ui/rovingIndex.ts:22-32`). caret/selection shortcuts can
move options instead of editing search. source-confirmed; platform repro
pending. the library instance has an
[existing ticket](library-picker-intercepts-modified-text-editing-keys.md).

prerequisites: none. editable inputs retain native home/end, modified arrows
and selection shortcuts; list navigation gets only its intended unmodified
keys. share the input contract rather than widening the noneditable roving
helper's responsibility.

acceptance: normal caret movement and modified selection work in all three
inputs; unmodified up/down still navigate options and enter selects only the
current target. verify on macos and the supported touch shell.
