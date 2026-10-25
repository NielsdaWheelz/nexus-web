# outline unlink action exposes its parent's raw identifier

lab25 `20261025-152150-4d7c6fee2b63`, source `aa29a9ecb`, resource-ui connections
case: the open relationship menu says `unlink from note_block:<uuid>` while its
parent note visibly reads `nimbus a1cdec`. screenshot `test-failed-2.png` confirms
this is product copy, not a missing menu or test selector.

`components/notes/LocalOutline.tsx` supplies `incoming.parentLabel: rootRef`;
`ResourceOutlineRow` correctly renders that supplied label. resolve the parent's
canonical display title at the outline owner, retaining a truthful unavailable
reference only when no title exists. the unchanged mounted connections case
must unlink by its visible parent name and preserve both endpoint resources.
