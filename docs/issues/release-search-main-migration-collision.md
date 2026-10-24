# integrate search against the actual main migration head

this search checkout cannot merge or release by combining migration files.
main currently defines root revision0306 in `0306_baseline.py` with its baseline
schema/data sql, followed by `0307_authored_identities.py` through
`0314_remove_dossiers.py`. search instead defines0306 in
`0306_indexed_occurrences.py` (parent0305) and0307 in
`0307_suggestion_owner_clocks.py`. identical revision ids represent different
schemas and ancestry; a plain merge would create ambiguous migration identity.

perform normal main integration first, reconcile current canonical product/schema
contracts, then express the accepted search data conversion in one migration
after main's actual head. verify populated conversion, preserved canonical
identities/vectors, indexed projection and source-owner clocks before production
cutover. reject unconvertible data; retain backup/paired-binary recovery. the
current fresh search-schema lab proves neither main conversion nor merge safety.

resolve after the integrated branch has one unambiguous chain and the actual
main-to-search conversion passes. no rebase or schema repair belongs to the
current lab workflow task.
