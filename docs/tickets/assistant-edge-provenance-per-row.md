# assistant connection rows each query their provenance

status: open · origin: 2026-10-10 graph reauthor (spec defect 3 remainder) · area: resource graph / assistant writes

`services/resource_graph/connections.py` `_hydrate` calls
`assistant_write_authorship.assistant_edge_provenance` once per `origin='assistant'`
row (authorship, receipt and chat tool-call lookups: up to four queries a row). the
reauthor batched every other per-row read of a connections page (document summary,
visibility probes, citation jumps); this one belongs to `assistant_write_authorship`.

fix: a batched `assistant_edge_provenance_for_edges(db, viewer_id, edge_ids)` in
`assistant_write_authorship.py` returning `{edge_id: (creation, mutation)}`, called
once per page.

done when: a connections page with N assistant rows issues a constant number of
provenance queries, and rows still show "View creation" and the Undo owner.
