status: open
origin: 2026-09-13 bounded workspace implementation
area: reader highlight queries

`useHostedTextHighlights.ts:119` fetches all fragment highlights through
`lib/highlights/api.ts:16`; `api/routes/highlights.py:58` has no range or page
contract. splitting publication content does not bound this separate live
projection. DOM admission can stop added spans but cannot bound the prior
response/list allocation. no observed highlight-driven OOM is claimed.

the payload is also unbounded per row: `schemas/highlights.py:83` embeds the
entire authored quote and every linked conversation/note block body;
`services/highlights.py:431` expands those collections. `list_highlights_for_media`
repairs missing fragment caches by loading all current normalized source text.
`reader_connections.py:94` uses the same whole-source resolution for passage
anchors, even when its connection rows are paginated. a row `limit` alone cannot
close this gap or bind locations to a retained publication.

prerequisite: retain existing highlight identities, source coordinates,
selection/editing, and sidebar access. inspect the actual service bound.
then use bounded unit-range read projection with explicit continuation for
all matching records; do not truncate highlights or freeze mutable annotations
inside publication artifacts.

acceptance: a large fragment with many highlights does not materialize the
whole list when one unit opens; every relevant highlight remains reachable,
and its DOM additions pass the view admission owner before construction.
