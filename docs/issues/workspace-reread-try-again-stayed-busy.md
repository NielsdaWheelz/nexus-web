# the workspace reread's "try again" once stayed busy

status: open, one sighting
origin: 2026-10-21 pane chrome harness, `runs/dev/tip-probe-1.txt` (600ccac94)
area: web / authenticated shell

after a server action whose layout reread failed (`GET /me/workspace-session`
503 through the hop), "workspace update not confirmed" showed with the
workspace kept, as intended. once the fault was cleared, "try again" stayed
busy for more than 20 s (`E.later-reread-failure-keeps-workspace`, screenshot
`runs/dev/tip-probe-1.txt.logs/fail-E.later-reread-failure-keeps-workspace-0.png`).
its busy state is the `useTransition` pending of `router.refresh()`
(`AuthenticatedShell.tsx` `WorkspaceEntryNotice`), so that refresh never
committed. no server error was logged. the journey passed in the 14 other
full cycles (7 on main, 7 on the branch) and in 16 isolated repeats.

impact: when it happens the notice cannot be retried until a reload; the
workspace itself stays usable.

resolved when: the stuck refresh is reproduced and its cause repaired, or
twenty full harness cycles pass the journey without it (then delete this).
