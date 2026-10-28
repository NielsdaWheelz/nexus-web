# lab firefox startup can time out before navigation

problem: a headless firefox qualification case timed out in
`apps/web/scripts/lab/browser.ts:50` at `launchPersistentContext`, before any
scenario navigation. the runner's worker teardown also exceeded 60 seconds.
this yields no product verdict and delays qualification.

evidence: baseline `6d6a6799c`, run `20261028-150627-f901fa699ba1`, case
`resolving capability 700`; private trace under that run's
`artifacts/playwright/pane-query-overflow-resolving-capability-700/trace.zip`.
the lab completed owned teardown; no owned firefox process remained afterward.

cause is unestablished. rerun the unchanged guard with the same browser helper;
the unchanged 700px guard passed in the subsequent focused run; this establishes
intermittence, not a launcher repair.
if repeated, capture browser launch diagnostics and repair the actual launcher
or resource owner. do not change product behavior or weaken assertions.
resolved when the cause is identified and the affected launch/teardown reliably
completes under the existing lab resource contract.
