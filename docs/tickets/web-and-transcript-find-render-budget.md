# web and transcript find keep a frame budget for rendering

status: open; read from code, not run · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: reader find

epub find's rendered-fragment wait has no frame deadline because a slow
highlights read held the rendered state back past its 48-frame budget and
crashed the pane (observed at 500-1500ms delays). the same 48-frame budget
remains in `useMediaPaneFind.ts:49/564` ("Web Find preview fragment did not
render.") and `transcriptPaneFind.ts:33/214`, and the web rendered state is also
withheld until layout readiness, which waits for the highlights gate.

fix: apply the epub rule — "not yet rendered" is not a defect — to both waits.

acceptance: a web or transcript preview across fragments survives a 1500ms
highlights read and a hidden tab.
