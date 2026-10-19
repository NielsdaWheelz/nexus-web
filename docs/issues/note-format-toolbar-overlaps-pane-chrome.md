# note formatting toolbar can sit behind pane controls

on 2026-10-19, an isolated authenticated chromium journey on `d8b0d4a730`
selected the entire root note body near the top of its pane. clicking the visible
`Bold` control repeatedly failed: `PaneShell_controlRow` intercepted pointer
events. keyboard formatting and rich html paste remained usable. this blocks
pointer formatting in that position; it is separate from deletion retention.

reproduce: open a note at the top of a desktop pane, select its body, then click
`Bold` in `Text formatting`. `components/notes/NoteEditor.module.css:10` places
that toolbar absolutely above its editor; `components/notes/NoteEditor.tsx:540`
renders it inside the editor shell. pane controls are owned by
`components/workspace/PaneShell.module.css:53` (all paths under `apps/web/src/`).

resolve by placing the formatting toolbar where pane chrome cannot cover it,
using the existing overlay/placement owner. prove pointer bold/italic/link actions
work at the top of a pane and after scrolling, without moving the selection.
