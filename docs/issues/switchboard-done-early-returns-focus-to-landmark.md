# "done" right after load returns focus to the pane, not the Nexus button

problem: opening the phone switchboard within about a second of the workspace
mounting, then choosing "done", returns focus to the active pane's landmark
instead of the Nexus button that opened it. settled pages return to the button.

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

resolved when "done" returns focus to the Nexus button however soon after
mount the switchboard was opened, in repeated harness runs without the settle
wait.
