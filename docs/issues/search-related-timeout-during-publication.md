# active related search expires during publication

status: open; the latest integrated browser/read gate fails on `b5234285` under
the former3s api cap. approved deadline changes are not yet qualified.

strict-v6 proves one changed input and one fresh request per phase using browser
monotonic dispatch, existing request ids and h2. keyword completes200 at870.39ms
and paints in1332ms. related returns504 after3032.92ms. the deadline fires during
presentation after provider803ms, indexed selection280ms and extra semantic
retrieval1843.94ms. the final stage is not evidence that presentation alone caused
the timeout. the restored-background retry waiver does not cover this active read.

a completed diagnostic on the same `b5234285` runtime returns20 results,18 with
semantic evidence, in4204.427ms before http transport and paint. provider takes
1685.57ms, semantic count221.35ms, ann scoring1081.16ms, reading projection51.69ms
and presentation670.86ms. the original3000ms due point falls inside ann scoring.
this measures completed work, not browser or p95 acceptance. the owner now
approves api5000ms and browser/bff5750ms failure budgets, retaining the warm4000ms
target and requiring related paint within5000ms during publication. those changed
budgets and the affected operation are not yet verified.

the raw diagnostic receipt remains failed on its stale indexed-sql hash guard.
replacing only the approved owner expression reproduces the observed sql exactly,
with the same parameters; this explains the guard mismatch without relabeling the
receipt or rerunning the operation. private evidence:
`search-release-integration/publication-diagnostic-remote/`.

initial publication completes; the held replacement commits in one audited attempt.
unrelated edits, source/fixture restoration and owned cleanup pass independently.
the [note-search admission gap](search-publication-note-check-waits-for-admission.md)
has its own attribution. earlier incomplete recorders do not establish after-input
ordering or paint; publication overlap does not prove native-merge causality.

resolved when the affected active related operation completes with its required
semantic evidence and painted results under approved product deadlines and limits.
