# compose libraries creation with the toolbar cutover

status: pending branch integration; neither isolated candidate is broken
origin: 2026-10-15 toolbar handoff; libraries `48897f9d5`, toolbar `225830792`
area: libraries / pane toolbar composition

toolbar makes `PaneQueryToolbar.status.visible` mandatory and migrates collection
adapters. both branches edit `LibrariesPaneBody.tsx`: toolbar's adapter still
uses `filterRows`, while creation replaces that hook with visit-owned `query`
and `rowStatus` (lines 444–456 at `48897f9d5`). blindly choosing either side
drops a contract.

when combining the branches, preserve creation's query capture, `rowStatus`,
primary action and creation lifetime. apply toolbar's `canReset`, shared
`headerMeta` and explicit status visibility, using the existing
`paneFilterRowsStatusVisible({ status: rowStatus, identityCount, atDefaultView })`.
derive `identityCount` from that same `headerMeta`; use `!canReset` for
`atDefaultView`. retain the status content/id. do not restore `usePaneFilterRows`
or default the new field. shared toolbar geometry stays owned by toolbar.

acceptance: integrated `./scripts/test` passes; default complete count is not
repeated, filtered/partial states retain their status, and create/open/back still
restores filter, sort and collection position. qualify affected 320px/zoom
geometry before claiming the composed source passes. delete this ticket after
integration and verification. this note does not claim either source was merged.
