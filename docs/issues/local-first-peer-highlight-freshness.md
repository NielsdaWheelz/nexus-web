# shared-library peers' highlights need audience invalidation from projections

a viewer's local authored corpus holds only their own highlights. other library
members' highlights reach the reader solely through the remote document map
(`python/nexus/services/reader_document_map.py`, `mine_only=False`).

the cutover keeps the existing audience owner: `resource_grants.invalidate_annotation_visibility`
bumps each readable viewer's media `annotations` lane (also for library, membership
and grant changes) and now wakes that viewer's `/stream/writing`, whose
`annotations_revision` changes; the map carries `annotations_version`. highlight
changes now arrive only through the authored projection, which must call
`highlights.annotations_changed`.

impact until wired: a peer's new, edited or deleted highlight appears in another
member's open reader only after reload.

evidence: lab case 3c in `apps/web/.nexus-lab/cases/backend_cutover.py` fails at
"the author's new highlight must invalidate the peer's document map".

resolved when `services/authored/projections.py` calls `annotations_changed` for
every projected highlight and highlight link endpoint, case 3c passes, and an open
shared reader refetches its map when `annotations_revision` moves.
