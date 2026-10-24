# search release migration reconciliation

main `9ca8d44e8` owns the squashed `0306` baseline and authored-identity
`0307`, followed by the chain through `0315`. the search branch reused `0306`
for indexed occurrences and `0307` for suggestion clocks, with a different
pre-baseline ancestry. copying those revisions or stamping the old qualification
clone would misrepresent which conversions actually ran.

candidate reconciliation preserves main’s exact `0306`–`0315` files, removes the
three branch-only lexical/indexed/clock revisions, and adds
`0316_indexed_search_publication.py` after `0315`. its frozen extractors include
only the fifteen surviving families. no dossier, manual-author or link-note
implementation returns.

read-only deployment-owner inspection at `2026-10-24T22:28:19.704502Z` observed
production pointer `dc12792e0fd407361be846d73b74b3b332313a17` and schema `0312`.
this is a starting observation, not a release freeze. existing `0313`/`0314`
loss/device preparation and `0315` remain part of the actual upgrade. postgres
must provide the pinned preloaded extension before `0316`; config/image changes
remain with their deployment owner.

resolved when the final candidate passes static checks and populated rehearsal
from a verified actual production-revision backup, preserves canonical/vector
state and the legacy suggestion revision/timestamp, proves all surviving logical
and native occurrences, and the integrated branch has one unambiguous migration chain. production
rollout remains owned by release-search.md.
restore the verified backup and matching code for recovery; do not stamp or
reinterpret the older `0292` or search-branch `0307` qualification datasets.
