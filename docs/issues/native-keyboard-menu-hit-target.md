# native menu target while typing

paired `eb5c9ebf6`, samsung/gboard run
`20261026-130803-fbf0b5964a67`, reached exact held-backspace/continued-input
checks offline, then could not open the nexus menu with the keyboard showing.
`mobile-editor-native.spec.ts:184` reports the visible menu button covered by
the command bar's redo svg, then the workspace route content. no forced event
was sent. the physical failure screenshot shows a blank viewport above the bar.

the cause is unproved: playwright repeatedly scrolled the fixed target before
the screenshot, and the trace lacks native webview dom snapshots. distinguish
an actual layout/hit-target defect from automation-induced visual-viewport
scrolling before changing product code. capture pre-click layout/visual viewport,
scroll, button/bar rectangles and hit targets; preserve the original action.

resolved when an ordinary native menu activation reaches saved-local status
with gboard open and this journey completes offline restart/reconnect with exact
canonical writing. no current native completion claim.
