# mobile nexus Places leaves focus on the document body

status: open · origin: 2026-10-09 workspace harness baseline (J14.mobile-nexus-place-focuses-pane) · area: nexus / mobile focus

on mobile, choosing a Places row (Notes) navigates the active pane in place and
closes the nexus, but focus lands on `<body>`, not the pane landmark (spec J14:
nav/nexus activation moves focus to the pane landmark). the host focuses the
landmark only when the active pane changes (`WorkspaceHost` focus layout
effect) or on `requestPaneFocus`; an in-place navigation of the same pane does
neither.

resolved when: harness J14.mobile-nexus-place-focuses-pane passes with its
xfail removed.
