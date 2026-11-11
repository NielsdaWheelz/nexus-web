# resource context menus have incomplete coverage

resource actions and context gestures still have separate entry points.
`apps/web/src/components/resources/ResourceIndexRow.tsx:161` and
`components/collections/CollectionRow.tsx:109` supply overflow triggers to
`ContextualActionMenu`. `ResourceOutlineRow.tsx:396-398` attaches relationship
commands to the bullet, while `:420` separately mounts resource actions.

`components/ui/ActionMenu.tsx` already owns context gestures. the same resource
nevertheless lacks a consistent resource-menu target across index and outline
appearances. this is a current source finding, not a new device reproduction.
removing overflow buttons alone would remove access and their attention anchors.

resolve when explicit resource targets share the existing action composition
across supported context gestures and visible menu entry points. retain exact
occurrence authority, native editing and selection, an accessible activation
path, loading feedback and focus after dismissal or removal.
