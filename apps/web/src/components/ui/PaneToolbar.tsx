import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneToolbar.module.css";

/**
 * A pane's control row. `search` leads (the pane's text input, and any command
 * that must stay beside it); `filters` are the pane's options; `controls` its
 * contextual actions; `summary` a collection's applied constraints and result state.
 */
export default function PaneToolbar({
  variant,
  search,
  filters,
  controls,
  summary,
  className,
}: {
  variant: "Refinement" | "Instrument" | "Collection";
  search?: ReactNode;
  filters?: ReactNode;
  controls?: ReactNode;
  summary?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.toolbar, styles[variant], className)}>
      {search ? <div className={styles.search}>{search}</div> : null}
      {filters ? <div className={styles.filters}>{filters}</div> : null}
      {controls ? <div className={styles.controls}>{controls}</div> : null}
      {summary ? <div className={styles.summary}>{summary}</div> : null}
    </div>
  );
}
