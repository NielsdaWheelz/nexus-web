# source note bodies are omitted from the reader

status: open; correction locally verified; forward deployment and phone pending

at deployed `695ddbd1f`, `reader_evidence.py:278–337` emits complete rich/plain
note bodies in `evidence.source_targets`, reached through each source reference's
`target_refs`. non-generated web code consumes neither field.
`EvidencePane.tsx` renders reference rows; `EvidenceRow.tsx:141` passes the marker's
bounded resource preview to `ResourceOutlineRow`, whose expansion follows user
connections rather than apparatus relations. painted marker clicks are intercepted
by `TextSurface.tsx:228–240`, so their ordinary authored link does not supply the
missing note detail.

impact: repaired complete note bodies can be stored and returned by the api while
the reader shows only the reference preview. this blocks the required rendered
note acceptance; it is not repaired by changing publisher text or note extraction.

ordinary chrome on repaired `09f34c39`, generation4, returned the verified complete
78-character body through the api. clicking its rendered marker opened the
reference row without that body. the saved cursor remained exact, with zero
reader-state/activity writes. private receipt: canonical-695ddbd1f/web09f-source-note-red.json.

resolve by composing the existing source-target content and
reader inspection contracts in the evidence owner. retain rich content, directed
targets, source/return and no implicit progress. the demonstrated large-map
memory failure additionally requires identity-bound target detail and a normalized
reference index under one wire11 cutover. verify complete content and source/return
with absent and existing saved cursors on web and phone; retain the existing
resource controls.

local `b748a3ace` passes actual rendered78- and634-character epub note bodies,
lazy disclosure removal, canonical source activation and explicit return. an
unchanged649-character note preserves the full positioned revision22 cursor;
the78-character case preserves the absent cursor. both return axes match their
departures with zero reader/activity writes. an unchanged article also passes
complete rich content, lazy collapse and source/return. private proof:
forward-fix-b748a3ace/local-note-09f34c39.json, existing-cursor-return.json and
local-article-note.json. these are local real-stack proofs, not canonical-artifact,
production or physical-phone acceptance. the largest note map has a separate
[api memory blocker](large-note-map-api-memory.md).

the final normalized wire11 candidate `726976d8e` repeats the short-note,
positioned-cursor and article checks through real opened-only detail reads.
source/return preserves both axes and exact saved state with zero progress writes.
the largest repaired book also renders its complete note and retains generic
resource controls. canonical artifacts, deployment and phone acceptance remain
pending; the phone is disconnected.
