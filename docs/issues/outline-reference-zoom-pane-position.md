# native text zoom can leave the active pane offscreen

problem: native firefox 200% text zoom can move the active workspace pane entirely
outside the visible horizontal pane rail. the selected reference remains correctly
laid out inside that pane, but the user cannot see it until the rail scrolls back.

evidence: the isolated native firefox check observed
`width=1440`, `mode=text`, `zoom=2`, `fullZoom=1`, `textZoom=2`, and
`paneVisible=false`; reference text starts around x=11305 css pixels. this persists
after 600 ms. document, pane and row horizontal overflow are zero; a trusted native
selection-button click scrolls the pane back and selects the exact row. seven other
normal/narrow page/text zoom cases keep the active pane visible. observed on the
outline-reference interaction worktree. untouched `bebedeae3` web served separately
reproduces the same case: `paneVisible=false`, x=11198, width=1222, with native
`fullZoom=1` and `textZoom=2`. its original menu's select-block command still works
after scrolling the pane back. this workspace defect predates reference anchors
and selection buttons.

reproduce in an isolated firefox profile with a normal-width workspace containing
several panes and the outline layout fixture: select/clear a wrapped reference,
switch native page zoom 100%→200%, then text zoom 100%→200% at 1440 px window width.
use firefox's actual zoom controls or privileged `ZoomManager`; css scaling and
viewport emulation do not reproduce this observation faithfully.

inspect `components/workspace/usePaneCanvas.ts:229` (active-pane resize reveal),
`components/workspace/WorkspacePaneCanvas.tsx:84` (scroll capture/restoration), and
`components/workspace/WorkspacePaneStrip.tsx:253` (horizontal reveal), alongside
`components/resources/ResourceOutline.module.css`; paths are under `apps/web/src`.
resolved when the active pane remains visible after full/text zoom
transitions at normal and narrow widths, with the native reference selection target
still reachable and no unintended horizontal document overflow.
