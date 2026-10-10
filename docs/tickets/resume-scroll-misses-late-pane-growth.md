# a resume leaves the active pane partly or wholly off-screen

status: open · origin: 2026-10-10 workspace host reauthor (cleanup/workspace-host-reauthor), c2wh review · area: workspace / host canvas

the host scrolls the active pane into view once per activation
(`WorkspaceHost` effect on `activeId` → `usePaneCanvas.scrollPaneIntoView`,
smooth, `inline: "center"`), against the layout of that moment. on a resume, and
when a desktop → mobile → desktop round trip remounts the inactive panes, panes
left of the active one keep growing after that scroll starts (lazy bodies,
labels, an inactive pane's Companion publishing its tabs), and nothing re-aims
it. main has the same effect and call, afaict; not run there.

evidence (c2wh stack, build 459e14098, workspace [Libraries, Heathland, Alpha,
Beta, Nightjar], Nightjar active, 664px wide):

- no Companion open: after the resume the canvas glides 0 → 514 → 1405 and
  Nightjar ends 265px in view; after a 390px round trip, 560px.
- Heathland's Inspector open (360px, published after the scroll began): the same
  glide to 1405, Nightjar 0px in view; after the round trip, 200px.

impact: after a reload the pane the user was working in can be off-screen,
always when an Inspector is open in a pane left of it.

what to do: the canvas keeps aiming at the activation target while its
geometry changes (its ResizeObserver already watches the canvas and every pane
wrap), until the user scrolls, drags or wheels the canvas or another pane is
activated.

acceptance: host harness `H-R1b.resume-with-a-companion-left-of-the-active-pane-keeps-it-in-view`
passes (drop its xfail).
