# recursive visibility estimates can make membership scans expensive

the restored corpus's recursive media visibility relation estimates 662,296 rows
but returns 820. in direct-search plan157, contributor-credit admission scans
that result 1,204 times, averaging 324 rows per scan. the contributor branch takes
58.9 ms; recursion itself runs once. private evidence:
`.nexus-local/search-qualification/plan157-client/run/artifacts/selection-plan-156.private.json`.

the current search repair shares visible ids through joins. it does not repair
the recursive estimate or qualify other consumers of the self-contained credit
visibility query in `nexus/auth/permissions.py:173`. do not add persisted visibility
state or statistics machinery without a measured remaining cost.

resolve when remaining affected credit reads have measured acceptable plans, or
reuse shared visibility without per-credit linear scans. preserve catalogue,
media and podcast visibility and exact row membership.
