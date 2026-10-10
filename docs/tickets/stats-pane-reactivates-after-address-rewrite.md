# the stats pane re-activates itself after its in-place address rewrite

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor), c2nv harness X1 · area: web / workspace, stats

follow Stats from the Account menu, then shift-click Settings in the same menu
at once: the Settings pane is created, but Stats stays active at
`/stats?view=stats&period=day&anchor=<today>`. the stats pane body
canonicalizes its address in place after mount (adds `view`, `period`,
`anchor`), and that in-place rewrite re-activates its own pane, so a fork made
before it lands behind the source. outside the nav slice: the rail and the
Account menu hand the fork to `activateWorkspaceTarget`, which activates the new
pane; the later rewrite undoes it.

evidence: harness journey `X1.fork-right-after-follow-keeps-new-pane-active`,
XFAIL on main 36e43224b (baseline.txt, rebase-baseline.txt) and on the rewrite:
"forked Settings exists but Stats is active at
/stats?view=stats&period=day&anchor=2026-10-10".

what to do: an in-place address canonicalization must replace the visit's href
without activating the pane (the workspace store's in-place replace path, or the
stats body's call site).

resolved when: X1 passes (its xfail removed) and the stats address still
canonicalizes.
