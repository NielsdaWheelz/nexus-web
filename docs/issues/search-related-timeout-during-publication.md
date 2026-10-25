# integrated related search expires during publication

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
