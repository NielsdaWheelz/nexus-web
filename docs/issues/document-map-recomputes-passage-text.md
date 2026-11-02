# the document map computes passage text twice

status: open; confirmed in source, cost measured. accepted by the connections scroll
work, whose spec forbids the wire or schema change a fix needs.

problem: `resource_items_out` computes every content passage's `text_parts` while it
hydrates, inside `project_excerpts` in full mode
(`python/nexus/services/resource_items/items.py:603`, the reader map through
`python/nexus/services/reader_evidence.py:132`) or in one `text_parts` batch in compact
mode (`items.py:625`, the capture map through
`python/nexus/services/reader_document_map.py:255`). it keeps `exact` only for the
120-character label (`items.py:288`). `PassageResourceBodyOut` carries the view, not the
text (`python/nexus/schemas/resource_items.py:116`). `build_markers` then wants each
passage's full `exact` for its preview, so `preview_texts` spawns a second helper over the
same bodies (`items.py:742`, `python/nexus/services/reader_evidence_markers.py:102`).

impact: one extra node process per document map request. timed on this mac at load 10
with synthetic plain bodies: 106ms median for 1 body, 115ms for 281, so startup is
nearly the whole cost. no wrong output.

fix: the hydration's `exact` has to reach `build_markers`. either the item contract
carries a passage's plain text, or the map callers take previews from the projections
they already hold. both change `resource_items_out`'s or the item's contract.

resolved when `build_markers` spawns no helper of its own, and every marker's preview
is unchanged.
