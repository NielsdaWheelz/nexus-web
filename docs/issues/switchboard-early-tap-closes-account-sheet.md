# a tap in the switchboard's opening frame closes the sheet it opened

problem: on a phone, tapping "account" in the same moment the Nexus switchboard
opens (before its initial focus lands) opens the account sheet and closes it
again. a tap 600 ms after opening works.

impact: a quick user's tap is lost; the sheet flashes. no data effect.

evidence: pane chrome harness (`nexus-web-campaign-artifacts/2026-10-21/chrome/
harness/baseline.txt`, D10): 1 of 4 immediate taps on main 631dba5dc, 0 of 4
after 600 ms; the harness now waits for the task's own focus
(`journeys/lib.mjs` `openSwitchboard`). the task's initial focus
(`components/switchboard/SwitchboardTask.tsx` → `MobileFullScreenTask`
`initialFocus`/`focusKey`) appears to land after the sheet admits, and the
focus move dismisses the sheet as an outside interaction. not traced further:
the initial-focus and admission order belong to the overlay kernel
(`lib/ui/overlay.ts`, the overlays slice).

resolved when an immediate tap on "account" (and any other switchboard control)
after the Nexus button keeps the sheet it opens, in repeated harness runs
without the focus wait.
