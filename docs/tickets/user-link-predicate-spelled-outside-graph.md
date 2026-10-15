# the user-link predicate is still spelled out beyond the graph

status: open · origin: 2026-10-10 graph reauthor · area: resource graph, capabilities

inside the graph "is a link" is `origin = 'user'` (the writer stores only neutral,
canonical links; migration 0268 proved it for stored rows). the outline reads
(`services/outline.py`) use it alone. one reader still restates the old five-part
predicate: `python/nexus/services/resource_items/capabilities.py`
(`_PAGE_NOTE_BLOCKS_SQL`, the user link closure: `kind = 'context'`, null ordinal,
snapshot and order key beside `origin = 'user'`).

fix: reduce it to `origin = 'user'` in the actions slice's next pass.

done when: `git grep -n "origin = 'user'" python/nexus` shows no companion
kind/ordinal/snapshot/order-key conjuncts, and the page note-block expansion returns
the same rows.
