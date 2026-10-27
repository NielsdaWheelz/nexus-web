# handset 100,000-block cold and warm opening exceed their budgets

latest installed samsung sm-s906w/android16/webview156.0.8078.47 campaign,
`20261027-120454-66402784678c` (source f5d7), misses cold10 p90 3,064ms
against3,000ms and warm50 p95 150.4ms against150ms. search50 p95 192.4ms
and typing300 p95 40ms pass. all cold samples are witnessed; the cold p90
sample includes2,360.6ms from renderer navigation. all eleven os admission observations
and ten local appends pass; the budget stop precedes final upload-prefix and
canonical append assertions. the run ended with canonical and hardware cleanup.

prior `6d580d3e3`, run `20261027-091006-a066f797484a`, also missed cold
and search. source repair removed duplicate first queries and closed-picker
queries. the preceding c48 campaign passed cold at2,997.6ms but missed warm
at156.7ms; neither result excuses the current two budget failures.
read-only diagnostic `20261027-102311-63b107ebe5b4` recorded repeated
initial document-state reads; logpoint overhead does not establish their
acceptance latency. loading now certifies state with its actual snapshot revision
and reuses it once only for an equal-revision initial subscription delivery,
preserving ordinary receive/bookkeeping. the current campaign qualifies its
search and typing behavior, but does not close cold or warm capacity.

retain budgets, sample counts, corpus/history and native launch-intent clock.
resolve with the full fresh paired campaign, including exact final upload,
canonical append order and owned cleanup. retain temporary inputs until then.
