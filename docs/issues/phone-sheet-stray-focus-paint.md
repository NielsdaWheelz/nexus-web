# phone sheet focus paint needs qualification after the redraw

historical evidence: touch-emulated chromium, 390×844, `42618db32` on
2026-11-15; not a handset observation. first opening painted a focus box on the
previous pane, closing a pane left a neighbour's close tooltip visible, and
choose-create/browse headings acquired field-like focus rings.

impact: programmatic focus appeared to claim a keyboard selection, and the
standing tooltip obscured a title.

the thumb-index redraw (`02c38da85`) changed the first two paths: opening arms
nothing and focuses a hidden heading; the close control in
`apps/web/src/components/switchboard/SwitchboardTask.tsx` is now a plain button.
there is no evidence that the old tooltip mechanism survives. heading focus
and recovery remain owned by `useNexusController.ts` `initialFocus` and the
sheet's focus handoff; the reported touch cases have not been rerun.

resolved when: opening, closing a pane and visiting choose-create/browse with
touch produce no stray ring or tooltip, while hardware-keyboard focus remains
visible. archive any case already removed by the new focus path.
