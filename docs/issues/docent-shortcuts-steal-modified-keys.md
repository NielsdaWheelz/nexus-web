# docent walk keys listen at the document

status: open (narrowed by the chat re-slice) · area: web / chat, keyboard

the walk's keys no longer steal modified keys: `apps/web/src/components/chat/Docent.tsx`
`useDocentWalk` ignores events with meta, control, alt or shift, composition, editable
targets (the shared `isEditableTarget`), prevented events and active overlays, so
command/control+p prints and modified arrows edit or scroll.

what remains: n/p, the arrows and Escape still listen on the document while a walk is
active, independent of where focus is (the chat spec keeps those keys document-wide). a
focused control elsewhere that wants a plain n/p or arrow (a slider, a custom list) loses
it during a walk.

fix: own navigation in the focused walk component, or give the walk an explicit focus
scope, and drop the character aliases unless that scope is explicit.

acceptance: during a walk, plain n/p/arrows reach a focused non-editable control that
handles them; the walk still steps from its own controls.
