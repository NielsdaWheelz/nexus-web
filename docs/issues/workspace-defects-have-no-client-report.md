# workspace defects have no retained client report

problem: workspace-wide client failures are logged only to the browser console,
unlike pane failures. the most disruptive failure boundary
therefore omits the existing sanitized client diagnostic path.

evidence at `c0acf77c3`: `apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:30-32`
only calls `console.error`. `components/workspace/PaneRouteErrorBoundary.tsx:45-53`
calls `reportClientDefect`; its bounded
beacon transport lives at `lib/telemetry/clientDefects.ts:15-45`. paths after the
first are relative to `apps/web/src/`. source inspection only.

impact: an absent console capture can leave a workspace incident unattributed;
pane telemetry cannot establish the initiating cause of a workspace failure.

fix: extend the existing bounded sanitized report contract with explicit failure
scope, then report workspace failures with component and deployed-build identity.
retain the existing exclusion of expected stale-build responses and authored
content. do not add a second telemetry system.

resolved when an isolated workspace defect yields one attributable sanitized
report and its failure surface, with no authored text or duplicate report; normal
stale-build handling remains excluded.
