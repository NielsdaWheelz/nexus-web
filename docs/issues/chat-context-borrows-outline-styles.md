# chat context, collection rows, import rows and the annotation host borrow the outline's private styles

status: open · origin: resource references re-slice (S4), 2026-10-19 · area: chat web, collections, imports, notes

`apps/web/src/components/chat/ChatContext.tsx` imports
`components/resources/ResourceOutline.module.css` for its own layout (`.tools`,
`.metadata`). #683 (1d79259b9) added two more outside importers for the disclosure
arrow and bullet: `components/collections/CollectionRow.tsx:37` (`.control`, `.arrow`)
and `components/imports/ImportRow.tsx:6` (`.control`, `.arrow`); #688 (1da52fc94) a
fourth, `components/notes/AnnotationNoteHost.tsx`. the outline styles are
the row's internals; the map's borrowed classes moved into `EvidencePane.module.css` in
the re-slice.

impact: a change to the outline's css can break the chat's context header.

resolved when: no file outside `components/resources/` imports
`ResourceOutline.module.css`.
