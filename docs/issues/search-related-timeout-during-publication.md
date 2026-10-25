# integrated related search expires during publication

on `d7350208`, the controlled operation again publishes once and proves durable
unrelated edits plus restoration. keyword completes200 in1076.68ms at the api;
active related returns504 after3023.24ms, now during extra semantic retrieval.
the restored-background waiver does not cover this active request.

a separately completed post-restoration diagnostic takes5466.88ms: provider
1330.79ms, initial neighbours78.37ms, indexed selection531.70ms, extra semantic
retrieval1919.95ms and presentation1573.56ms. within extra retrieval, the actual
vector statement takes1167.56ms and selected reading-owner resolution609.87ms.
these are elapsed observations, not cpu attribution or publication-time latency.
private evidence: `search-release-integration/highlight-final-diagnostics/remote/`.

the old browser recorder mixes node wall time with chromium's time origin, so
this operation proves neither after-input ordering nor painted-result latency.
its request-id-joined api results and independent transaction observations stand.
the replacement recorder passes one ordinary local lab using a single browser
monotonic clock for input, existing request-id dispatch and paint; shifted wall
timestamps leave its verdict unchanged. use that recorder for the next operation.
no deadline, engine, ranking or resource change is implied.

historical failed receipts below retain their original meanings.

the affected operation on `a3e6b8ee2` receives api504/E_SEARCH_TIMEOUT after3044ms.
the correlated api timer fires at3001ms; the bff forwards that response rather
than reaching its3750ms cap. provider work takes about1510ms, admission45ms,
initial neighbours53ms and indexed selection194ms. extra semantic retrieval starts
about1850ms into the budget and expires after another1152ms; cleanup joins in13ms.
this is not admission domination or a browser-cache attribution.

keyword completes200. related failure is the after-input target, so the accepted
restored-background failure/retry waiver does not cover it. the collector then
misreads the error body as results and skips postcommit edit/searchability checks.
preserve completed observations and the original failed verdict.

private evidence: `search-release-integration/corpus-client/run/artifacts/`
contains phase bodies, browser timing and request-id-joined api/bff traces.
resolve through a complete affected operation with independently saved results.
any longer publication-time allowance needs measured completion and an explicit
product decision; do not change ranking or declare an engine failure from this.

current `7776e45f6` controlled populated operation proves publication once, durable
unrelated edits before and after commit, original source equality and complete
owned cleanup. search still fails: keyword504 after1570.70ms and active related504
after3019.98ms. keyword spends1352.69ms in indexed selection until cancellation;
related spends1149.99ms in provider work,70.39ms in initial neighbours and1376.17ms
in indexed selection until cancellation. neither reaches extra semantic retrieval
or presentation. note search also returns504. cancellation markers are not
successful phase completions. both focal api intervals overlap publication;
that does not establish native merging as their cause.

a later completed read-only native plan takes1972.731ms with2,448,748 buffer hits
and zero physical reads. it exposes repeated highlight admission against unrelated
readings; see [the owning issue](search-highlight-admission-scans-unrelated-readings.md).
the private source-prefilter probe preserves all ten eligibility columns for3,429
rows in both directions within one repeatable-read snapshot. its native plan
completes in165.603ms with78 anchor checks, replacing roughly269,000 checks.
this is a mechanism result, not actual bff latency, p95 or publication acceptance;
affected retained checks and the browser/publication journey remain pending.
current private observations are in
`search-release-integration/final-client/run/artifacts/` and `final-diagnostics/`.
retain the failed combined verdict and unchanged deadlines. this active failure
remains outside the restored-background waiver.
