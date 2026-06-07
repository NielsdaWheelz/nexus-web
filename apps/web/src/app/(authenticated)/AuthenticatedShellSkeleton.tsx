import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import layout from "./layout.module.css";
import styles from "./AuthenticatedShellSkeleton.module.css";

// The first HTTP flush: the shell chrome (nav-rail placeholder + pane region in its loading
// state) painted before any FastAPI call resolves and before app JS runs. Streamed as the
// layout's Suspense fallback while WorkspaceBootstrapGate awaits the data root (S4). The pane
// region reuses PaneLoadingState so the skeleton → pane-loading → content transition is
// seamless (D-8). Server component, CSS-only — no client JS, CSP-safe.
export function AuthenticatedShellSkeleton() {
  return (
    <div className={layout.layout} data-testid="shell-skeleton">
      <div className={styles.rail} aria-hidden />
      <main className={layout.main}>
        <PaneLoadingState />
      </main>
    </div>
  );
}
