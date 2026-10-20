# remaining fixed-shortcut browser qualification

status: open · origin: 2026-10-14 shortcut removal · area: web / keyboard

the 2026-10-20 authenticated disposable qualification observed desktop
command+k and control+k opening nexus, repeated/held chords preserving its
state, nested menu ownership, native query editing and menu focus. a chromium
context with a windows user-agent exercised server-derived platform hints and
control+k; this did not qualify a native windows host.
narrow current, absent and extant destination activation also preserved pane
identity, history and focus. see `docs/modules/app-navigation.md` for the current
gesture contract. native screen-reader qualification is separately tracked in
`palette-screen-reader-qualification.md`.

the remaining fixed shortcuts were not exercised by that change:

- settings and nexus expose the four-shortcut reference; old browser-local
  assignments have no effect after reload.
- native mac control+k remains a text-edit command; extra modifiers and
  composition do not invoke app shortcuts.
- command/control+f searches only the active ready pane, including its editor;
  unsupported/resolving panes and overlays retain browser find.
- command/control+shift+left/right activates adjacent visible panes from body
  and pane-tab focus, clamps at edges, and yields to editing and overlays.
  plain pane-tab arrows move focus without activating a pane.

owners under `apps/web/src/`: `lib/shortcuts.ts`,
`components/nexus/useNexusController.ts`, `components/workspace/PaneShell.tsx`,
`components/workspace/WorkspacePaneStrip.tsx`, and
`lib/workspace/adjacentPaneKeybindings.ts`.

resolved when those remaining journeys are observed on mac and a control-key
platform. the static gate does not establish runtime behavior. existing custom
highlight minifier warnings remain in
`offline-css-minifier-rejects-highlight-syntax.md`.
