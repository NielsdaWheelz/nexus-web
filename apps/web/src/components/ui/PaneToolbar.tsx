"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneToolbar.module.css";

type PaneToolbarVariant = "Refinement" | "Instrument";

const variantClass: Record<PaneToolbarVariant, string> = {
  Refinement: styles.refinement,
  Instrument: styles.instrument,
};

export default function PaneToolbar({
  variant,
  search,
  filters,
  controls,
  className,
}: {
  variant: PaneToolbarVariant;
  /**
   * The toolbar's leading row: the text input the pane owns, and any
   * command that must keep one place beside it rather than migrate
   * between rows as the wrapping filter set changes width.
   */
  search?: ReactNode;
  filters?: ReactNode; // filter chips/selects the pane owns
  controls?: ReactNode; // right-aligned contextual toolbar controls
  className?: string;
}) {
  return (
    <div className={cx(styles.toolbar, variantClass[variant], className)}>
      {search ? <div className={styles.search}>{search}</div> : null}
      {filters ? <div className={styles.filters}>{filters}</div> : null}
      {controls ? <div className={styles.controls}>{controls}</div> : null}
    </div>
  );
}
