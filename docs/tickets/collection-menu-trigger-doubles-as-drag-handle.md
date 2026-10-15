# collection menu trigger doubles as a drag handle

status: deferred design follow-up
origin: 2026-10-14 menu design audit
area: web / collections / reorder

`apps/web/src/components/collections/CollectionRow.tsx:97-115` attaches the
sortable activator and mouse/touch listeners to the menu trigger, whose visible
content is only an ellipsis (`components/ui/OverflowMenuButton.tsx:14`).
click suppression at `:116-123` arbitrates
drag versus opening. a visually familiar menu control also means "move this
item"; the drag affordance is supplied only in screen-reader text (`:87-91`).
no actual failed drag was demonstrated in this audit.

the owner's 2026-10-14 clarification limits the current redesign to button
appearance. changing drag behavior is not part of that scope.

prerequisite: separately decide whether to change the reorder affordance. a possible fix is a separate grip only
where the current collection permits reordering; retain the existing move
up/down menu commands (`:275-297`) and keyboard alternative. reuse the current
sortable implementation. accept the small space cost instead of overloading
the menu gesture.

acceptance if approved: menu presses reliably open the menu and never start dragging; the
grip clearly starts reorder. title activation, touch scrolling, keyboard moves,
focus after reorder and filtered/sorted non-reorder states remain correct.
