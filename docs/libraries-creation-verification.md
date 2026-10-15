# libraries creation verification

status: browser qualification passed; physical keyboard acceptance pending. 2026-10-15.

this records evidence for the [creation specification](libraries-creation-plan.md), not full completion. qualification used isolated accounts and real browser → bff → api → database writes and public reads. creation response faults followed real commits; refused commands received real bff/api refusals. no production test seam was added.

the baseline is `367da80e0c1beb1c426f6d2d72201b0733809b50`. [the main receipt][main] records hashes of all twelve changed/new application files; those hashes still match the reviewed source. the unchanged `./scripts/test` [passed][gate], including migration head `0278`. this gate establishes static consistency, not user behavior.

## evidence

[four baseline behavioral reds][baseline] proved the permanent form row, lost filter after back, replacement of an unconfirmed request with another id/name, and duplicate creation after mobile departure/back. these were observable failures of the old behavior, not missing future selectors.

fourteen candidate cases passed. case ids below identify the exact records; screenshots accompany the main and surface receipts.

| acceptance | evidence |
|---|---|
| entry, dismissal and validation | [c1][candidate]: no inline form, one header command, keyboard entry, name focus, tab containment, escape/cancel, return focus, draft discard and local blank/reserved/overlong validation. [s1][entry]: creation remains available while loading, after list failure and with an invalid view. |
| foreground creation and return | [c2][sort]: trimmed 100-code-point name accepted by the real server, rapid submits produce one delivery, same-pane navigation, filter/sort restoration and the same visible row at its retained offset. |
| relinquished ownership | [c3][candidate]: close/reopen pending, immutable name, retained focused action and receipt without automatic navigation. [c6][sort]: hidden success neither reopens nor steals focus; changing sort preserves the latest visit. [e2][extra]: hidden definite refusal stays hidden, preserves outside focus and permits correction. |
| uncertainty, identity and stale completion | [c4, c5, c7][candidate]: lost acknowledgement, real refusal after uncertainty, identical replay and one resulting library; mobile unmount/back, overlapping same-id deliveries and inert old completion; mismatched acknowledgement reaches the defect boundary and preserves the attempt for replay. successful back starts a fresh draft. |
| response deadline and authoritative validation | [e1–e3][extra]: a [real committed response body][stall] was stalled; uncertainty appeared after 30,134ms and identical replay yielded one library. initial permission/name refusals created nothing; correction succeeded, with the server name error associated with and focused on the field. |
| pane isolation and geometry | [s2–s4][surfaces]: 320px desktop pane, 32px command before more, 400px dialog cap, scrim dismissal; 390×844 mobile viewport, 48px command and browser-back dismissal; independent index tasks and unique field/error/invitation references across two panes. |
| native zoom | [firefox geometry and screenshots][zoom]: normal, actual 200% full zoom and 200% text zoom pass entry, blank validation and close checks, with no internal header/dialog overflow. text zoom widens the existing horizontal workspace canvas; the command stays inside its pane. this does not claim that the whole canvas fits the viewport. |

main browser: chromium `147.0.7727.15`, headless, at 1440×900 and 390×844. zoom browser: firefox `158.0`, with native full/text factors recorded. composing enter/escape checks used synthetic composition/key events; they prove the event guards, not a native ime session. mobile emulation does not prove physical touch or keyboard clearance.

## corrections and remaining work

earlier candidate failures were harness errors: label lookup included select options; raw scroll offsets ignored row anchoring; a sort url was read before commit; one dropped get was recovered by the existing three-attempt retry. corrected semantic/settled assertions passed. native zoom setup also needed auth readiness and fresh element lookup after responsive remount. the docker read-only incident interrupted setup before candidate assertions and was not counted as a product failure.

the [physical handset check](tickets/libraries-dialog-physical-keyboard-unverified.md) remains open: the owner confirmed device unavailability until morning. verify the field, validation error, submit and close with the actual keyboard shown, then correction and a real creation. there is no full-green or completion claim. source/content review found no additional product blocker; native composition remains an explicit coverage limit.

all libraries created by the completed cases were deleted successfully; the isolated invitation fixture remains for the remaining check. [interim cleanup][cleanup] stopped the baseline runtime and removed its source archive. the candidate runtime, disposable runners, fixtures and private state remain outside the checkout until the physical check and any affected rechecks finish. then remove task-owned runners, dependencies, profiles, credentials, services and data, retaining receipts and screenshots. no permanent test suite, ci job or alternate gate remains.

[main]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/qualification-main.json
[gate]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/static.log
[baseline]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/baseline/results.json
[candidate]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/candidate/results.json
[sort]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/candidate-sort-settled/results.json
[entry]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/surfaces-entry/results.json
[surfaces]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/surfaces/results.json
[extra]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/extra/results.json
[stall]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/body-stall-proxy.jsonl
[zoom]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/native-zoom/final-zoom.json
[cleanup]: ../../nexus-web-campaign-artifacts/2026-10-14/libraries-creation/receipts/interim-cleanup.json
