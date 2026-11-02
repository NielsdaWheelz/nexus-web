# lab firefox launch times out under contention

`firefox.launchPersistentContext` in `apps/web/scripts/lab/browser.ts` can outlast
playwright's 180s launch timeout before any navigation, while other labs and browsers
load the host.

impact: a lab case's firefox tests fail with the launch, so one exit 1 can read as a
css failure until someone opens the log.

evidence: 2 of 17 row facts sweeps on 2026-11-01, `20261101-170914-19c0d73cd7f3` on
baseline and `20261101-175719-e78eb2e75c88` on the branch, with other sessions'
browsers and labs running and load near 15. both logged `Timeout 180000ms exceeded`
with no page loaded. the branch sha passed on rerun; the baseline sha had passed in the
run before.

fix: in `openLabBrowser`, retry a timed-out firefox launch once, and report a second
timeout as a launch failure rather than a case verdict.

resolved when a forced launch timeout retries once, a second one names the launch in
the case's result, and a contended sweep no longer needs a manual rerun.
