"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneToolbar.module.css";

type PaneToolbarVariant = "Refinement" | "Instrument" | "Collection";

const variantClass: Record<PaneToolbarVariant, string> = {
  Refinement: styles.refinement,
  Instrument: styles.instrument,
  Collection: styles.collection,
};

export default function PaneToolbar({
  variant,
  search,
  filters,
  controls,
  summary,
  className,
}: {
  variant: PaneToolbarVariant;
  /**
   * The toolbar's leading row: the text input the pane owns, and any
   * command that must keep one place beside it rather than migrate
   * between rows as the wrapping filter set changes width.
   */
  search?: ReactNode;
  filters?: ReactNode; // pane-owned options, order and filter controls
  controls?: ReactNode; // contextual actions
  summary?: ReactNode; // applied constraints and result state for collections
  className?: string;
}) {
  return (
    <div className={cx(styles.toolbar, variantClass[variant], className)}>
      {search ? <div className={styles.search}>{search}</div> : null}
      {filters ? <div className={styles.filters}>{filters}</div> : null}
      {controls ? <div className={styles.controls}>{controls}</div> : null}
      {summary ? <div className={styles.summary}>{summary}</div> : null}
    </div>
  );
}
