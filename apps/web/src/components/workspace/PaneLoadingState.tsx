"use client";

import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./PaneLoadingState.module.css";

/**
 * The one pane placeholder. The caller decides whether this first load is
 * announced; inactive panes stay silent. A refresh belongs to the shell.
 */
export function PaneLoadingState(props: {
  readonly label: string;
  readonly announcement: "None" | "Polite";
}) {
  const runtime = usePaneRuntime();
  if (runtime !== null && props.announcement === "Polite") {
    return <ActivePaneLoading label={props.label} />;
  }
  return <Placeholder label={props.label} announces={props.announcement === "Polite"} />;
}

function ActivePaneLoading({ label }: { label: string }) {
  const active = usePaneIsActive();
  return <Placeholder label={label} announces={active} />;
}

function Placeholder({ label, announces }: { label: string; announces: boolean }) {
  return (
    <div
      className={styles.root}
      role={announces ? "status" : undefined}
      aria-live={announces ? "polite" : undefined}
      aria-atomic={announces ? "true" : undefined}
    >
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className={styles.bar} aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}
