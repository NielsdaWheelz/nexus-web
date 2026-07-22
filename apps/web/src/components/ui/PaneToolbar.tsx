"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneToolbar.module.css";

export default function PaneToolbar({
  search,
  filters,
  controls,
  className,
}: {
  search?: ReactNode; // a text input the pane owns
  filters?: ReactNode; // filter chips/selects the pane owns
  controls?: ReactNode; // right-aligned contextual toolbar controls
  className?: string;
}) {
  return (
    <div role="toolbar" className={cx(styles.toolbar, className)}>
      {search ? <div className={styles.search}>{search}</div> : null}
      {filters ? <div className={styles.filters}>{filters}</div> : null}
      {controls ? <div className={styles.controls}>{controls}</div> : null}
    </div>
  );
}
