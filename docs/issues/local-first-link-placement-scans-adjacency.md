# link placement must read bounded indexed neighbors

`apps/web/src/lib/resourceGraph/links.ts:position` traverses every adjacency page
and retains full resource projections merely to append a link or find adjacent
position keys. adding one note on a large page therefore transfers/retains the
whole page's bodies. the server's `prepare_server` append path also loads every
incident link. this cannot qualify the handset's 100,000-block contract.

add closed shared link-position queries for the endpoint tail, an exact selected
neighbor pair, and only an observed equal-key run with its distinct boundaries.
return link/position metadata, not note bodies. sqlite/postgres endpoint position
indexes must serve the bounded ordinary case. keep equal-key rekey atomic and
reject an oversized command without truncation.

resolved when real firefox/handset insertion on a 100,000-block endpoint uses
bounded metadata in the ordinary distinct-key case, tie insertion changes only
the observed run, and both delivery orders converge.
