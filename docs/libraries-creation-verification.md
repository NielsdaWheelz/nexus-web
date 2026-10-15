# libraries creation verification

status: browser qualification passed; disposable stack/tests removed; physical keyboard proof deferred by owner. 2026-10-15.
pr: [629](https://github.com/NielsdaWheelz/nexus-web/pull/629).

## source and method

four [behavioral baseline reds](assets/libraries-creation/baseline/results.json) on `367da80e0` proved the permanent row, lost filter, changed uncertain identity and duplicate creation after mobile departure. missing future selectors were not counted as reds.

current-main qualification used `447ecd11c43cac99e3a4f0b234ea386881f19ec1`, integrated with main `7bc7c8a13`. ordinary browser auth → bff → api → isolated postgres writes and public reads passed. the current api uses `{id,name}` and generated snake_case types; the retired client/codecs were not restored. [start](assets/libraries-creation/integrated/qualification-start.json) and [end](assets/libraries-creation/integrated/qualification-end.json) snapshots match across 24 source files. unchanged `./scripts/test` [passed](assets/libraries-creation/static.log), migration head `0286`.

## observed behavior

all fourteen [live cases](assets/libraries-creation/integrated/qualification.json) passed:

| cases | proof |
|---|---|
| [c1–c3](assets/libraries-creation/integrated-candidate/results.json) | entry, validation, focus/tab/dismissal, unicode100 boundary, one delivery, same-pane open/back with retained filter/sort/row anchor; pending close/reopen retains name and focus without re-arming navigation |
| [c4–c7](assets/libraries-creation/integrated-candidate/results.json) | real committed lost acknowledgement, identical replay/cardinality1, refusal after uncertainty, mobile unmount/back, overlapping old/new deliveries, hidden success after sort, and mismatched acknowledgement through the defect boundary |
| [s1](assets/libraries-creation/integrated-surfaces-entry-qualified/results.json), [s2–s4](assets/libraries-creation/integrated-surfaces/results.json) | creation during loading/read failure/invalid view; 320px desktop command32/dialog≤400; 390×844 mobile command48/back; independent visits and unique dialog/invitation references |
| [e1–e3](assets/libraries-creation/integrated-extra/results.json) | stalled real committed response reaches uncertainty after30,372ms and identical replay resolves one library; actual initial403/name400 create nothing, then corrections succeed with field semantics |

[stock firefox158 native zoom](assets/libraries-creation/native-zoom/integrated-zoom.json) passes entry, blank validation and dismissal at normal, full200% and text200%. no internal header/dialog overflow; text zoom widens the existing horizontal workspace canvas. [narrow dialog](assets/libraries-creation/integrated-surfaces/s2-320px-pane-header-and-dialog.png), [mobile](assets/libraries-creation/integrated-surfaces/s3-mobile-portrait-geometry.png), [text200 error](assets/libraries-creation/native-zoom/integrated-text-invalid.png).

chromium147.0.7727.15 was headless. composing enter/escape checks used synthetic events, not a native ime. emulation does not establish physical keyboard clearance.

## limits, corrections and disposal

four [integration harness corrections](assets/libraries-creation/integrated/harness-corrections.json) are retained: remove a read fault before server sort validation, use the dedicated invalid-view title, settle the held read before the next sort, and scope the deep-linked command to its active pane. failed attempts are retained as harness failures, not product reds or green evidence. source reviews by independent implementers found no remaining feature defect.

the owner subsequently instructed `pr, merge, clean everything up`; the [handset check](tickets/libraries-dialog-physical-keyboard-unverified.md) remains explicitly deferred, not passed. no device mutation occurred.

all case-created libraries were deleted successfully. [cleanup](assets/libraries-creation/cleanup.json) records six task-owned containers, three fixture volumes, two networks and all server/proxy groups removed; task ports closed. other task resources were preserved. disposable runners, profiles, credentials, setup and external proof/cache roots are deleted; implementation worktree cleanup follows merge; only inert receipts/screenshots remain in this directory. no permanent suite, ci job or production failpoint was added.

toolbar628 composition is coordinated before merging629: preserve its mandatory `status.visible`/`headerMeta`/`canReset` contract and this feature's visit-owned filter/task. inspector617 remains a separate candidate; primary sizing is deliberately separate from the companion rule so its future coarse target is not clamped. peer qualification alone is not a combined-source claim.
