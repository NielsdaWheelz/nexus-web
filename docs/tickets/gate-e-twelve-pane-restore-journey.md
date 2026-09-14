# gate e has no artifact: twelve-pane restore, pinned selection and slow cancellation

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: composition qualification / gate e

## what is wrong

gate e reads: "twelve-pane restore, pinned selection and slow cancellation remain
within budgets; views take priority; old prefetch settlement cannot alter a
replacement."

only the last clause has receipts (`bounded-workspace-client-progress.md:137-140`).
no proof, fixture, journey or scenario for a twelve-pane restore exists:
`apps/web/e2e/journeys/` holds sixteen journeys, none a workspace restore at
scale, and grep for `twelve`/`12-pane` across `apps/web/src`, `apps/web/e2e` and
`python/tests` returns only an unrelated chat-budget proof. `MAX_PANES = 12` is
real product code (`apps/web/src/lib/workspace/schema.ts:29`).

this is the gate that decides whether the bounded-workspace thesis holds under
the pane limit the product actually allows, and it is the one with zero evidence,
while several hundred receipts were spent on component-level lifetime proofs. the
risk is an architecture qualified unit by unit that still exceeds budget in the
composition the original incident exhibited. both dossiers concede it
(`progress.md:44`, `client-progress.md:168`).

## prerequisites

a committed candidate and the real-stack journey lane.

## proposed fix

build the twelve-pane restore as an **enclosing journey against the real stack**:
restore a stored twelve-pane layout, keep one pinned selection and one in-flight
slow cancellation live, and assert the recorded browser lease/decoded-byte budget
plus zero API kills — the same receipt shape as the `api-capacity` scenario so
the browser and server numbers can be compared. register it in
`testdata/proofs.json` with the workspace risk.

simulating twelve panes inside a component test is not acceptable: the failure
mode under review is aggregate residency across real bodies and real DOM, which a
mocked harness cannot exhibit.

## acceptance

the journey restores twelve panes with a pinned selection and a live slow
cancellation, publishes a lease/decoded-byte receipt comparable with the
`api-capacity` numbers, and records zero API kills.

2026-09-14 component work, not journey acceptance: the actual WorkspaceHost
residency proof now exists at
`apps/web/src/components/workspace/ReaderWorkspaceResidency.browser.test.tsx`.
it restores twelve compact visits and mounts real pdf bodies/workers for the
displayed panes. it does not yet supply the required enclosing API/cgroup receipt.

fixed snapshot run `d6589ed13b4bbf0c` delivered trusted horizontal wheel input
to the pdf instrument row; that row intentionally contains horizontal overscroll
(`PaneShell.module.css:54`). the expected canvas displacement was a fixture
error, not evidence of broken canvas scrolling. the reviewed correction targets
ordinary top chrome and preserves the pin/displacement/worker oracles. its
replay at `d0c00e72e19e119408586f486836e89117961de6` is pending.
