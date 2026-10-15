# inactive mobile reader tabs lose their title

status: open · origin: 2026-10-15 selection-composer live qualification · area: workspace / nexus labels

restore a workspace containing several direct-url article tabs on a mobile
viewport with a chat active, then open nexus. its source tab is labelled `Media`, although that reader
previously showed its actual title before the workspace reload. multiple direct-url readers become
indistinguishable. observed in an ordinary authenticated isolated session at
390×844; no selection-composer state is involved.

`WorkspaceHost.tsx` mounts only the active mobile body. nexus uses pane labels
while the restored runtime title owner has not mounted. keep the resolved title with the pane's
existing label owner; do not keep inactive reader bodies mounted to retain it.

acceptance: two differently titled direct-url articles retain distinct titles
in nexus after workspace reload while both are inactive; returning to either preserves its visit state.
