# pane minimize has no keyboard path

status: open · origin: 2026-10-16 pane tabs design review · area: web / workspace accessibility

problem: the pane strip exposes minimize only through a button excluded from
keyboard navigation. a keyboard user can restore and close panes but cannot
minimize one.

evidence: `apps/web/src/components/workspace/WorkspacePaneStrip.tsx:148` sets
the minimize button's `tabIndex` to `-1`; its roving handler at lines 68–87
visits only pane activators and implements arrows, home/end, delete/backspace.
the sole ui invocation of `minimizePane` is the strip callback wired in
`apps/web/src/components/workspace/WorkspaceHost.tsx:158`. the pane menu in
`apps/web/src/components/workspace/PaneShell.tsx:249` and manage-tabs page in
`apps/web/src/components/nexus/NexusPages.tsx:158` expose no minimize command.
this is source evidence; an authenticated browser was not exercised.

prerequisites: keep minimize (hide a pane) distinct from a future workspace
maximize (show the active pane at full workspace width).

proposed fix: expose minimize through a reachable pane action menu or include
it in the strip's complete roving-control model. keep the last visible pane
guard in the workspace store; an added shortcut must not be the only route.

acceptance: using only the keyboard, minimize any eligible pane and restore it;
focus remains on a live, predictable control. the last visible pane cannot be
minimized, and its disabled action explains why. mouse and touch remain usable.
