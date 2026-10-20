# disposable bootstrap times out compiling the initial route

problem: the first action-menu baseline invocation failed during real browser
login/bootstrap before the driver ran. no product behavior was tested.

evidence: run `20261020-002037-ba1a2a5c9ea0`, source `d9e7d86aa`, mac host.
`browser-bootstrap.log`: `goto: Timeout 30000ms exceeded`, navigating to the
owned web origin `/` and waiting for domcontentloaded. `web.log` ends at
`Compiling /[[...path]] ...` after login succeeded. two other disposable apps
were active. api and worker readiness passed; owned services were removed.

impact: cold compilation/contention can consume bootstrap's navigation budget.
retry the unchanged command after caches warm; do not call this a menu red or
extend product latency budgets. if reproducible, repair the runtime bootstrap's
cold-start/readiness contract at its owner with a bounded deadline.

resolved when a fresh real bootstrap consistently reaches the driver within its
documented budget under the intended local runtime load, without product seams.
