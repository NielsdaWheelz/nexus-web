# resource action parity reaches the wrong mobile pane

## restoration update, 2026-09-14

pr #254 removes the automated suite/harness cited below. retain this historical
observation for manual product/capacity investigation; its old test commands and
proposed test-routing changes are superseded by the direct `./scripts/test`
contract. removal of the suite does not resolve an unconfirmed product concern.


- status: open
- origin: 2026-09-14 highlight popup session; run `18b20381b30bf394`
- area: workspace navigation / browser journey

`apps/web/e2e/journeys/resource-action-parity.journey.spec.ts:596`
navigates to a media reader, then clicks the generic `More` button at line 599.
the run failed with `mobile pane bar: the action menu did not open.`
the retained screenshot and `error-context.md` show the prior **Browse** pane,
its podcast query, and a `More` button; no reader or Companion is present.
`openActionMenu` (line 86) checks only trigger visibility/enabled state, and
`apps/web/e2e/fixtures.ts:174` does not await the requested pane.

evidence: `test-results/runs/18b20381b30bf394/journeys-all-1.log` and
`playwright/resource-action-parity.jou-ff0c8-d-reconcile-a-real-mutation-journeys/`
beneath that run. candidate: `6c9e8a89e4a183f774500bf0f2988fc327ed50f2`.
the highlight-note journey and component suite passed in the same run.
the unchanged base `7fa89b88c8342bca9edfb46a6d20053c49555fb2` passed the
focused journey in run `6bef0f2004207fdd`. the one diagnostic replay of the
unchanged candidate passed in `95c975cf43007f23`; the controller retains the
original failing verdict. the navigation failure is intermittent; its cause
remains unresolved.

prerequisite: inspect workspace restoration to distinguish a navigation defect
from a journey readiness race. await the actual
requested reader before exercising its header; fix any restoration that selects
the prior pane. do not add sleeps, retries, or weaker menu assertions.

acceptance: the mobile step visibly opens the requested media reader, then
verifies its full canonical menu; the focused journey passes without retries.
