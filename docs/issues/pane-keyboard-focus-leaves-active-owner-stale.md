# pane keyboard focus leaves the active owner stale

status: open · origin: 2026-10-16 pane-tabs review · area: workspace / keyboard focus

evidence: `apps/web/src/components/workspace/WorkspaceHost.tsx:178-185`
activates a visible pane only on mouse down; keyboard focus entering a sibling
pane has no activation handler. `PaneShell.tsx:206-221` dispatches pane search
from `isActive`, while its only focus handler (`:467-469`) expands find.
`lib/workspace/adjacentPaneKeybindings.ts:25-28` likewise traverses from the
stored active pane. source-confirmed; no browser reproduction was run.

impact: after tabbing into a visible inactive pane, command/control+f can open
search in the previously active pane. new close or maximize shortcuts that
trust the same owner could act on the wrong pane.

prerequisites: two visible desktop panes, both with keyboard-reachable controls
and search. reproduce: activate the first, tab into a control in the second,
then invoke pane search.

proposed fix: give the workspace host one explicit rule for focus entering a
pane, updating active identity without moving focus again. preserve the strip's
separate focused-item and active-pane states, overlay ownership, and deliberate
canvas position. commands must resolve their pane at dispatch.

acceptance: keyboard focus, pointer activation, active chrome and command target
agree within pane content; search targets the pane containing focus; traversing
strip items still leaves activation to the documented action. adding close or
maximize cannot operate on a stale sibling.
