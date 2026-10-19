# mobile nexus Places leaves focus on the document body

status (2026-10-18): deleted on main by #655 without a recorded resolution, while an uncommitted 2026-10-16 recheck (below) was still adding evidence; restored from that recheck. unverified: `useNexusController.ts` now carries `pendingPaneFocus`; the same-tab path needs a recheck.

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

2026-10-16 source review: also qualify selecting the already-current tab.
`components/nexus/useNexusController.ts:137–162` activates it and suppresses
dialog return focus; `components/workspace/WorkspaceHost.tsx:105–130` focuses
only a changed active id, an explicit focus request, or a relevant breakpoint
change. the same-pane path has no destination focus request. paths are relative
to `apps/web/src`. this extension is source-inferred, not a new handset result.
acceptance includes same-tab selection, in-place destination navigation and
switching to another tab; each focuses its intended destination without stealing
the focus promised by note-entry or pane-return workflows. use current manual
verification rules rather than reconstructing the retired harness.
