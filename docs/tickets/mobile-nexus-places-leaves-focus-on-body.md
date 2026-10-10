# mobile nexus Places leaves focus on the document body

status: open · origin: 2026-10-09 workspace harness baseline (J14.mobile-nexus-place-focuses-pane) · area: nexus / mobile focus

on mobile, choosing a Places row (Notes) navigates the active pane in place and
closes the nexus, but focus lands on `<body>`, not the pane landmark (spec J14:
nav/nexus activation moves focus to the pane landmark). the host focuses the
landmark only when the active pane changes on mobile, on `requestPaneFocus`, or
on a breakpoint flip that lost focus (`WorkspaceHost` focus layout effect,
`apps/web/src/components/workspace/WorkspaceHost.tsx`); an in-place navigation
of the same pane does none of these. the host rewrite
(cleanup/workspace-host-reauthor) kept it deliberately: moving focus on every
visit change in the host would fight the return memento's keyboard focus
restore and pointer Back (workspace harness J5.pointer-back-moves-no-focus).

what to do: the nexus Places close path returns focus to the active pane's
landmark after its activation (it owns the intent), not the host.

resolved when: harness J14.mobile-nexus-place-focuses-pane (workspace harness;
ported to the host harness as WS.J14.mobile-nexus-place-focuses-pane) passes
with its xfail removed.
