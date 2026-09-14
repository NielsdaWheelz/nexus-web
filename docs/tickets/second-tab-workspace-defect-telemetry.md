# workspace failures have no remote client receipt

status: open
origin: 2026-09-13 second-tab council; head `7fa89b88c8`; production `7e8fd48244b3b436965037738e05785bb4931be1`
area: workspace / diagnostics

the user reports intermittent whole-workspace fallback about a second after
opening another tab. the exact fallback belongs to
`apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:43–47`.
its `componentDidCatch` only writes to the local console at lines 70–71, in
both inspected revisions. production's inline pane boundary also only logs
locally; head's pane boundary reports remotely, but the workspace owner does
not. server logs cannot identify a client-only exception through this path.

prerequisite: distinguish server bootstrap failures from client host/provider
failures; preserve the existing structural telemetry privacy contract.

fix: give workspace/bootstrap and pane failures explicit reporting scopes,
with release, phase, safe error identity, component location, and request
correlation when available. do not fabricate pane ids for workspace failures
or send raw document content, credentials, or unsanitized error messages.

acceptance: a controlled shared-host exception produces one bounded,
release-correlated receipt and the workspace fallback; a pane exception
produces a pane receipt while its sibling remains usable. demonstrate the
missing receipt before the fix through `./scripts/test`.
