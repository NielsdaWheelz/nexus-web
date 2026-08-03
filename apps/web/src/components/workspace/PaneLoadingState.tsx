import styles from "./PaneLoadingState.module.css";

export type PaneLoadingAnnouncement = "None" | "Polite";

// The one generic pane placeholder. The caller owns whether this initial load
// is announced; a refresh stays with PaneShell and must not reuse this state.
export function PaneLoadingState({
  label,
  announcement,
}: {
  label: string;
  announcement: PaneLoadingAnnouncement;
}) {
  const announces = announcement === "Polite";

  return (
    <div
      className={styles.root}
      role={announces ? "status" : undefined}
      aria-live={announces ? "polite" : undefined}
      aria-atomic={announces ? "true" : undefined}
      aria-busy="true"
      aria-label={announces ? undefined : label}
    >
      <span className={styles.bar} data-testid="pane-loading-ink" aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}
