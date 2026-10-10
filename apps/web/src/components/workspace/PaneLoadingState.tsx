import styles from "./PaneLoadingState.module.css";

/**
 * The one pane placeholder. The caller decides whether this first load is
 * announced; a refresh belongs to the shell and never reuses it.
 */
export function PaneLoadingState(props: {
  readonly label: string;
  readonly announcement: "None" | "Polite";
}) {
  const announces = props.announcement === "Polite";
  return (
    <div
      className={styles.root}
      role={announces ? "status" : undefined}
      aria-live={announces ? "polite" : undefined}
      aria-atomic={announces ? "true" : undefined}
      aria-busy="true"
      aria-label={announces ? undefined : props.label}
    >
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className="sr-only">{props.label}</span>
    </div>
  );
}
