# handset 100,000-block warm open exceeds its budget

latest installed samsung sm-s906w/android16/webview156.0.8078.47 campaign,
`20261027-110515-dcd3209eefef` (source c48), completes cold10 p90 2,997.6ms,
search50 p95 207.6ms and typing300 p95 40ms within their unchanged budgets.
warm50 p95 156.7ms still exceeds150ms. all eleven os admission observations
and ten local appends pass; the budget stop precedes final upload-prefix and
canonical append assertions. the run ended with canonical and hardware cleanup.

prior `6d580d3e3`, run `20261027-091006-a066f797484a`, also missed cold
and search. source repair removed duplicate first queries and closed-picker
queries; this narrows the remaining observed failure to warm opening.
read-only diagnostic `20261027-102311-63b107ebe5b4` recorded repeated
initial document-state reads; logpoint overhead does not establish their
acceptance latency. loading now certifies state with its actual snapshot revision
and reuses it once only for an equal-revision initial subscription delivery,
preserving ordinary receive/bookkeeping. live verification remains pending.

retain budgets, sample counts, corpus/history and native launch-intent clock.
resolve with the full fresh paired campaign, including exact final upload,
canonical append order and owned cleanup. retain temporary inputs until then.
