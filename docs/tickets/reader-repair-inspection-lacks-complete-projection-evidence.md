# reader inspection cannot fully expose or reconcile its proposed apparatus

status: implemented in merged #609; final-artifact qualification pending
origin: 2026-10-14 book-repair adversarial review at `75b17c030`
area: reader maintenance / proposal review and uncertain commit

`python/nexus/services/reader_navigation_repair.py:54–82,1056–1065` reports
changed apparatus keys but not their full before/after values. its
`inspection_digest` (1019–1041) binds both projections and the old generation;
that digest alone cannot identify the installed result after an uncertain commit.
the command currently cannot supply the complete review/reconciliation evidence
required by the [book-repair plan](../book-repair-plan.md).

fix: extend the existing private inspection with full `item_changes` and
`edge_changes` using `_row_changes`, plus `installed_metadata_sha256` and
`proposed_metadata_sha256` using `_digest` over the existing normalized
metadata. retain the source/generation/proposal apply fence. no public api,
new snapshot store or general repair framework.

acceptance: full apparatus changes are reviewable before apply; post-apply
installed metadata hashes to the approved proposed hash. lost-reply recovery
checks that equality, exact source/generation and protected state before another
write. genuine non-commit, exact commit and divergent state remain distinct.
