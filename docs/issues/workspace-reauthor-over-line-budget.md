# workspace reauthoring is over its 3,000-line web budget

status: open · origin: 2026-10-09 workspace reauthoring (cleanup/workspace-reauthor) · area: workspace / budget

the rewritten slice's web files measure 3,220 formatted lines (prettier 3.9.9
defaults) against the 3,000 cap (coordinator R2: web only); python is 182
lines, counted separately (design 155). the design's §11 contingency (drop
same-path scroll retention, link label hints, descendant readiness) was not
approved, so no behaviour was cut.

evidence (formatted lines / design cap): store.tsx 694 / 560,
paneReturnMemento.tsx 430 / 390, paneRouteModel.ts 365 / 330, paneRuntime.tsx
341 / 270, paneResourceLoaders.ts 190 / 170, AuthenticatedShell.tsx 147 / 140,
targetLinkActivation.ts 127 / 105, model.ts 113 / 110, targetActivation.ts
113 / 110, useWorkspaceSession.ts 103 / 90, PaneRouteErrorBoundary.tsx 93 / 80,
paneRenderRegistry.tsx 91 / 90, bootstrap.server.ts 89 / 85, layout.module.css
76 / 58, layout.tsx 55 / 52, AuthenticatedWorkspaceErrorBoundary.tsx 46 / 44,
route.ts 28 / 25, PaneRouteBoundary.tsx 30 / 28; under cap: workspaceHref 27,
paneRouteKeyedRecords 25, adjacentPaneKeybindings 34, `[[...path]]/page.tsx` 3.
the overrun is mostly the store's explicit publication and pane-entry delivery
rules plus each command computing its whole next state with its capture
discipline, and the runtime's thirteen stable commands forwarded through one
latest-facts ref.

resolved when: the owner accepts the measured size, or a later cut brings the
web files under 3,000 without dropping a journey.
