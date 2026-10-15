# pane boundary offers retry for internal defects

status: open
origin: 2026-10-14 session-entry content/contract review; reconfirmed at `c533ac0d5`
area: web / pane failure ownership

`apps/web/src/components/workspace/PaneRouteErrorBoundary.tsx:34–43,64–83`
reports every render exception or lazy import rejection as a defect, then offers
the same remount/retry surface. invariant failures therefore receive product
recovery, contrary to `docs/rules/errors.md`. this remains outside session entry.

prerequisites: classify expected chunk-delivery failures at their existing owner.
keep modeled recovery separate from logged terminal defects; preserve pane-local
isolation and focus. do not infer retryability from a catch-all.

acceptance: interrupted chunk delivery remains recoverable; an internal invariant
failure is reported and receives no product retry. healthy panes stay mounted.
