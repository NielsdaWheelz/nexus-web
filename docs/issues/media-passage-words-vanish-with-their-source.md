# a media passage's words vanish with its source

status: open · found 2026-11-12 by reading at `125f1ab87`; not run · area: backend / resource items

`passage_anchors.py:3-5` says an anchor survives its owner's deletion. the read does
not honour that for media owners: the row is dropped unless `media_passages`
resolves it (`python/nexus/services/resource_items/items.py:564-588`), and
resolution returns nothing once the source's metadata is gone
(`services/resource_items/locations.py:396-398`). the item is then missing and reads
"passage unavailable". an owned highlight and a note-owned passage keep their words.

impact: server-backed item reads can hide a linked passage's words after source
deletion, though the store still holds them. this source finding does not establish
the behavior of every local authored view. which server behavior is intended is
not written down.

resolved when the contract says whether a passage keeps its words after its source
is deleted, and the read agrees for every owner kind.
