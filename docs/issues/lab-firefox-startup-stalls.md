# lab firefox startup can time out before navigation

problem: a headless firefox qualification case timed out in
`apps/web/scripts/lab/browser.ts:50` at `launchPersistentContext`, before any
scenario navigation. the runner's worker teardown also exceeded 60 seconds.
this yields no product verdict and delays qualification.

evidence: baseline `6d6a6799c`, run `20261028-150627-f901fa699ba1`, case
`resolving capability 700`; private trace under that run's
`artifacts/playwright/pane-query-overflow-resolving-capability-700/trace.zip`.
the lab completed owned teardown; no owned firefox process remained afterward.

recurrence: header run `20261028-174542-505f54038fc2` at `2ff5c8109`,
`page: unknown root admits no writer or mutations`, timed out before its body.
the private `test.trace` call `qrdq@441` begins `Launch persistent context` at
19351.775ms, with stack `browser.ts:50` → temporary case beforeEach:30, and
has no completion before the 60000ms hook timeout. worker teardown also timed
out at 60000ms. the other 23 passing cases establish no verdict for this
unrun page case. owned lab teardown completed with exit 1.
the unchanged unknown-root case passed in `20261028-180805-551298feac78`.

cause is unestablished. rerun the unchanged guard with the same browser helper;
the unchanged 700px guard passed in the subsequent focused run; this establishes
intermittence, not a launcher repair.
if repeated, capture browser launch diagnostics and repair the actual launcher
or resource owner. do not change product behavior or weaken assertions.
resolved when the cause is identified and the affected launch/teardown reliably
completes under the existing lab resource contract.
