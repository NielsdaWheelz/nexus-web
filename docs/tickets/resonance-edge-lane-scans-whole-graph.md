# the slate's edge lane owner-normalizes the whole graph on every read

status: open · origin: 2026-10-04 synapse reauthor (spec D10, branch cleanup/synapse-reauthor) · area: suggestions / performance

`python/nexus/services/suggestions.py:_candidates` builds `edges` from every
`resource_edges` row of the viewer in the six resonance origins, then runs
`owner_rows_sql` over all of their endpoints before joining the five anchors.
cost grows with the user's whole graph on each At hand, quick reads and
library-suggestion read, not with the anchors. it is performance only;
results are correct.

fix: filter `edges` to rows incident to an anchor's owned endpoints first (the
anchors' own refs plus `expand_owned_child_refs`-style children), then
owner-normalize only the far endpoints.

acceptance: EXPLAIN ANALYZE on a production-shaped fixture shows the edge lane
scaling with anchor degree, and the three slates return identical json before
and after.
