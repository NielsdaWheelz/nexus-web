# workspace hydration tree mismatch

status: open; older firefox mismatch remains unassigned
origin: 2026-10-16 principal-actions final menu qualification
area: web / server-client hydration

source `30bf3ed6ef3d2c2530f610a944d1d4d473a7615b`, standalone
`QEZcj_oxsLE7BMuWo4v_T`, Firefox Nexus-follow-up context emitted
`Minified React error #418`, decoder args `HTML` and empty string. installed
react-dom’s `throwOnHydrationMismatch` regenerates this tree; this differs from
the older [attribute-only warning](app-nav-intermittent-hydration-warning.md).
a common cause has not been established.

requested route was the task library index. all six Firefox focus assertions
and all18 final menu assertions passed, but the runner retained the error and
exited1. receipt began2026-10-17 02:52:00.395utc, not the error timestamp. only
the message was captured; event time/url, stack and mismatching element are
unknown. copied `nx_device` meant the sequential contexts shared a persisted
workspace; it is not evidence of independent-device behavior.

pr #655's physical android qualification used source
`41221d947d7e3e2f83d5418c220e158978671b4f`, standalone `D65Y_HNwsgYelcyCuk2ra`,
wire 10 / database 0292, debug package `app.nexus.android.mobilepalette20261016`,
apk sha256 `5abb3cd25a6b1b2b4295d8be4964046aaff4f8081230e32f8a2b2c98e753693b`.
final receipt `phone-native-1792210614882` recorded nine passed interaction
checks: overview/titles, keyboard/back, ime submit, finite returns, rotation,
done, tab close, same-visit open and highlight-note focus. six React #418 errors
with `HTML` decoder arguments remained: five labelled `setup` during fresh
navigation, one labelled `feature` at `2026-10-17T04:18:20.350Z` on
`http://localhost:31617/lectern` after ordinary Downloads → Back to Nexus.
the Downloads heading and returned Open Nexus assertions completed, but its
error guard failed; both report statuses were `failed`, with runner exit 1.
stack top: `rD` in `4bd1b696-100b9d70ed4e49c1.js:1:35062`, then `oq` at
`1:84566` and `ik` at `1:114682`; the mismatching component remains unknown.
earlier failed retries captured the same messages with incomplete timing or
phase evidence; pr #655 retains the qualification evidence before harness cleanup.
this was a native navigation failure on that candidate. its cause, whether it
predated the palette change, and a common cause with firefox were then
unestablished. the separate passing checks did not resolve it.

capture uncapped error/console/component details and the corresponding server
HTML/client tree on a reproducing authenticated load before assigning a cause.
retain event time, url, stack and phase (sign-in, fixture seed, or interaction),
including phase-transition timestamps, and the full campaign failure even if
individual interaction checks pass. controller readiness proves its effect ran,
not completion of all descendant hydration.
canonical AppNav’s rendered tree is unchanged here; its callback only loses the
retired pane-limit refusal. repair the diagnosed owner, without suppressing
hydration errors or discarding the observation through reruns.

acceptance: the captured mismatch reproduces before the fix and the same
ordinary route/retained-workspace load remains consistent afterward; affected
menu focus/command behavior still passes.

2026-10-17 wire-10 closeout: the reported native diagnosis identified player
availability being initialized from the client-only bridge before hydration.
`apps/web/src/lib/player/playerRuntime.tsx:232–247` now starts `unavailable` at
`null` on server and client, then observes bridge availability in the effect.
the historical closeout reported successful signed production downloads → nexus
and palette checks on `e623be68087e5f0870f44e772f3960e0bcd83d6d`; the
retained handback records required-consumer acceptance. the
[raw evidence was not retained](wire10-qualification-evidence-not-retained.md).
it does not assign or close the earlier firefox #418, or the separate
attribute-only warning.

2026-10-23: run `20261023-094017-ebab0e849fe5`, source `f7afce8a7`,
recorded the same `#418`/`HTML` stack in the separate android chrome auth
surface during cancel/wrong-account qualification. those assertions passed;
the event's exact route/component was not captured. the installed workspace
does not hydrate. no common cause or repair is established by this observation.
