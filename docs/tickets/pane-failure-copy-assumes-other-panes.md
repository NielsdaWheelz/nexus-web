# pane failure copy assumes other panes exist

status: open
origin: 2026-10-14 session-entry content review; reconfirmed at `c533ac0d5`
area: web / pane failure content

`apps/web/src/components/workspace/PaneRouteErrorBoundary.tsx:75` promises
“your other panes are still available.” the workspace schema permits one pane;
the claim is false in that supported state.

prerequisites: none. use copy independent of pane count, without a layout-state
query. coordinate recovery wording with [failure ownership](pane-boundary-retries-internal-defects.md);
do not promise a retry for internal defects.

acceptance: one-pane and multi-pane failures both receive truthful copy; any
modeled retry remains scoped to the failed pane and preserves focus behavior.
