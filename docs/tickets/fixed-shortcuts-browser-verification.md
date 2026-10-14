# fixed shortcuts need browser verification

status: open · origin: 2026-10-14 shortcut removal · area: web / keyboard verification

the fixed shortcut change passed `./scripts/test` (exit 0; migration head
`0277`) and independent source review. authenticated browser journeys were not
run: the local web/api services were not listening on 3000/8000, the configured
auth service was not listening on 54321, and `.dev-ports` contained only its
header. no runtime success is inferred from the static gate.

affected owners: `apps/web/src/lib/shortcuts.ts`,
`components/nexus/useNexusController.ts`, `components/workspace/PaneShell.tsx`,
`components/workspace/WorkspacePaneStrip.tsx`, and
`lib/workspace/adjacentPaneKeybindings.ts` under `apps/web/src/`.
impact: platform chords, focus and overlay behavior are source-reviewed but
unproved in a live browser.

prerequisites: an authenticated development stack with two visible panes and a
searchable pane. verify on mac and a control-key platform:

- settings and nexus reach the four-shortcut reference; no editing controls
  remain, and prior browser-local assignments have no effect after reload.
- command/control+k opens nexus from a text input; holding it does not open a
  result menu. a second press opens selected-result actions on desktop/mobile;
  a nested menu or other dialog retains interaction ownership.
- the native mac control+k text-edit command remains usable; extra modifiers
  and composition do not fire app shortcuts. hints and aria keys agree.
- command/control+f searches only the active ready pane, including from its
  editor; unsupported/resolving panes and overlays retain browser find.
- command/control+shift+left/right activates adjacent visible panes from body
  and pane-tab focus, clamps at edges, and yields to editing and overlays.
  unmodified pane-tab arrows still move focus without activating a pane.

acceptance: record those browser observations, repair any regression, then
delete this ticket. the static check's existing custom-highlight minifier
warnings remain tracked separately in
[the build ticket](offline-css-minifier-rejects-highlight-syntax.md).
