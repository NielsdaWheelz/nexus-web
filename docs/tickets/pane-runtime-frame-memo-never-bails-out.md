# PaneRuntimeFrame memo never bails out

status: open · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: workspace rendering

`PaneRuntimeFrame` in `components/workspace/WorkspaceHost.tsx` is wrapped in
`memo`, but its `children` prop is a new element on every host render, so the
memo never bails out and every host render re-renders every frame. it suggests
an isolation it does not provide; pane isolation now rests on the value-keyed
runtime context in `lib/panes/paneRuntime.tsx`.

fix: remove the ineffective memo, or pass stable children so it can bail.

acceptance: the memo either goes or measurably skips re-rendering unchanged
frames.
