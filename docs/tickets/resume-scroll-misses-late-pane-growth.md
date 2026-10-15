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

2026-10-14: actual `3839b96a0` firefox qualification also leaves active `114a`
mostly outside its canvas (`x=1178..1842`, canvas `240..1280`). the isolated
actual-hook/host-css probe reproduces complete loss after a preceding pane
grows from 1000 to 1800 px; no input or repeated reveal. receipt:
`/tmp/nexus-session-entry-release-20261014/canvas-growth-probe-3839b96a/receipt.json`.

the owner selected instant activation after native cancellation failed to stop
an obsolete smooth destination. the old smooth reds remain historical failures;
that motion contract is retired.

acceptance: late preceding-pane growth and growth during initial
activation keep a fitting active pane fully visible. deliberate horizontal pan
releases that aim; vertical reading and handled resize/tab keys do not. retain
the red/green receipts, delete the temporary probe and verify the actual consumer.
