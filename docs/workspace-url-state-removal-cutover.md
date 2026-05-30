# Superseded Workspace URL State Note

This document is historical. The current workspace pane state and session
contract is `docs/workspace-pane-system-consolidation-cutover.md`.

Current rule: workspace layout state is not encoded in the URL. The address bar
reflects only the active primary pane route. Session restore stores the
normalized workspace state with `activePrimaryPaneId`, `primaryPaneOrder`,
`primaryPanesById`, and `secondaryPanesById`.
