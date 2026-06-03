import styles from "./PaneLoadingState.module.css";

// The one pane loading placeholder: a quiet pulse skeleton. Used both as a pane
// body's own loading branch and as the React.lazy Suspense fallback.
export function PaneLoadingState({ label = "Loading…" }: { label?: string } = {}) {
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}
