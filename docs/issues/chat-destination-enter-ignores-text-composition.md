# chat destination enter ignores text composition

status: open
origin: 2026-10-16 shared control source audit
area: web / chat destination chooser / input

`apps/web/src/components/chat/ConversationDestinationOverlay.tsx:91-125`
has no composition handlers or native `isComposing` check. its enter handler
at `113-116` immediately selects the active chat (or retries a failed read).
confirming an ime candidate can therefore choose a destination while editing
search. source-confirmed path; device reproduction pending. the analogous
link-target defect is tracked separately in
[its ticket](link-picker-enter-ignores-text-composition.md).

prerequisites: none. leave composing keys with text input and apply the shared
editable-combobox contract without changing destination selection semantics.

acceptance: japanese/korean/chinese composition enter only confirms input;
a later ordinary enter chooses the visibly active chat. retry also ignores
composing enter.
