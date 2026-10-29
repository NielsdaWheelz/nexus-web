# closing nexus can return focus to the pane instead of its launcher

problem: opening the phone switchboard within about a second of the workspace
mounting, then choosing `close nexus` (formerly `done`), returns focus to the active pane's landmark
instead of the Nexus button that opened it. older settled runs returned to the
button; current baseline reproduction also affects keyboard opening.

impact: keyboard and assistive-technology users lose their place after an
early open; no data effect.

evidence: pane chrome harness (`nexus-web-campaign-artifacts/2026-10-21/chrome/
harness/baseline.txt`, D11): both pre-baseline runs on main 631dba5dc, 0 of 6
settled repeats; the harness now lets the restored document's entry focus land
first (`journeys/chrome.mjs` `seeded`). the controller records the opener as
`document.activeElement` when the task opens
(`components/nexus/useNexusController.ts:528`) and falls back to the pane
landmark when it is null (`:724`); an open made before the entry's own focus
settles likely records no opener, or the entry focus lands after it.

2026-10-28: unchanged source `492d01595`, disposable run
`20261028-171727-6eba1cec8783`, reproduces the same destination after waiting for
entry focus, explicitly focusing the launcher, opening with enter, entering
search and closing with space. the active element is the lectern `section` with
`data-pane-focus-landmark` and `data-active="true"`. the older timing hypothesis
is not a proven cause. the mobile-header icon change keeps this repair separate;
its behavioral dismissal checks and this focus diagnostic have distinct verdicts.

resolved when `close nexus` returns focus to the Nexus button however soon after
mount the switchboard was opened, in repeated harness runs without the settle
wait.
