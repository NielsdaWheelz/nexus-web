# workspace hydration tree mismatch

status: open; owner and reproduction unqualified
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

capture uncapped error/console/component details and the corresponding server
HTML/client tree on a reproducing authenticated load before assigning a cause.
canonical AppNav’s rendered tree is unchanged here; its callback only loses the
retired pane-limit refusal. repair the diagnosed owner, without suppressing
hydration errors or discarding the observation through reruns.

acceptance: the captured mismatch reproduces before the fix and the same
ordinary route/retained-workspace load remains consistent afterward; affected
menu focus/command behavior still passes.
