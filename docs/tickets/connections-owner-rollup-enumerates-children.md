# owner rollup re-enumerates every child per connections page

status: open · origin: 2026-10-10 graph reauthor (spec defect 2) · area: resource graph / connections, reader evidence

`query_connections(rollup="owner")` expands a media to all its spans, chunks,
fragments, highlights, apparatus items and passage anchors
(`services/resource_items/capabilities.py` `expand_owned_child_refs`) and matches them
as per-scheme `IN` lists on every page; the Evidence pane pages through all of them
(`services/reader_connections.py` `list_reader_connections`, 100 per page). cost grows
with document size, not with the number of connections. `owners.owner_rows_sql`
already expresses the inverse (child → owner) join.

fix: expand once per request in SQL (join edges to `owner_rows_sql` instead of
enumerating children), or page the reader projection once over all owned rows.
both owners (`capabilities`, `reader_connections`) are outside the graph slice.

done when: EXPLAIN on a 10k-chunk media shows one child expansion per Evidence load
and the Evidence pane and Connections owner rollup return the same rows.
