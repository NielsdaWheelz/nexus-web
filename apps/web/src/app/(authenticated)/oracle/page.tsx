// Standard pane-route shell: the workspace is driven by the restored URL→pane
// state, so this route renders nothing itself. The OracleLandingPaneBody chunk is
// a lazy pane warmed via preloadPane (D-7) — never eager-imported here, which would
// fold the pane body into the route's First Load JS and break the bundle budget.
// The landing's textarea stays inert until mounted (see OracleLandingPaneBody), so
// the hydration/lazy remount can't strand a half-typed, uncontrolled value.
export default function Page() {
  return null;
}
