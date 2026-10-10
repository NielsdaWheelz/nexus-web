# the user-link predicate is still spelled out beyond the graph

status: open · origin: 2026-10-10 graph reauthor · area: resource graph / notes, capabilities

inside the graph "is a link" is `origin = 'user'` (the writer stores only neutral,
canonical links; migration 0268 proved it for stored rows). two readers outside the
slice still restate the old five-part predicate:
`python/nexus/services/resource_graph/adjacency.py` (`incident_predicates`, notes
slice) and `python/nexus/services/resource_items/capabilities.py`
(`_PAGE_NOTE_BLOCKS_SQL`, the user link closure: `kind = 'context'`, null ordinal,
snapshot and order key beside `origin = 'user'`).

fix: reduce both to `origin = 'user'` in their owners' next pass.

done when: `git grep -n "origin = 'user'" python/nexus` shows no companion
kind/ordinal/snapshot/order-key conjuncts, and the outline and page note-block reads
return the same rows.
