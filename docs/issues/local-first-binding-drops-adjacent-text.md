# mixed-atom normalization loses concurrent text

the pinned y-prosemirror 1.3.7 binding deletes a text container when removing an
intervening atom. an unseen insertion into that surviving text's original
container is lost, although the user removed only the atom. this violates the
approved words/marks/refs preservation contract.

evidence: temporary real-yjs case
`apps/web/.nexus-lab/cases/semantics-atom.mts` creates `left`, image, `right`;
replica a removes only the image using `updateYFragment`, replica b inserts
` REMOTE` after `right`. apply a's delta to b: canonical text is `leftright`,
not `leftright REMOTE`. observed 2026-10-25 with yjs 13.6.33/y-prosemirror1.3.7.
`node/authored/node_modules/y-prosemirror/src/plugins/sync-plugin.js:1287`
deletes the extra XML text container; normalization at lines749–763 also moves
text by copying and deleting containers.

a binding that preserves text-container identity, or a different canonical
inline representation, is required. do not ship stock binding or weaken the
preservation requirement. resolved when removing an atom, typing/marking on both
sides, splitting/joining and both delivery orders preserve unrelated concurrent
edits with the actual mounted editor and persisted merge states.
