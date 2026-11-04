# a refused pane entry can stop the pane on a publish loop

status: open
origin: 2026-11-01 feedback-homes L0a repair
area: web / pane chrome

in firefox, entering Chats while admission refuses reads sometimes replaces the pane with
`this pane stopped unexpectedly`. the body republishes its chrome from `usePublish`'s
layout effect while the read is still `loading`, until react throws #185, maximum update
depth. a refused arrival settles in a microtask, so the race is short and the failure
intermittent. why the body re-renders on each publication is not known, idk.

impact: a pane that should show its read failure shows the defect boundary instead, and
reports a client defect.

evidence: `apps/web/src/lib/panes/paneChrome.tsx:204-205`. after a mismatch 403, then a
Chats pane entry in lab firefox: 4 of 10 at `fdd17ffd2` with trace logging, 0 of 10 at
`fdd17ffd2` without it, 3 of 10 and 1 of 10 at the L0a branch. chromium has not shown it.

reproduce: second account's cookies in a settled profile, wake sync until `sign in to
sync`, click Podcasts, wait, click Chats, repeat.

resolved when: a body in `loading` publishes a bounded number of times, and the journey
above stops no pane in twenty firefox runs.
