"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./ResourceCell.module.css";

/** One linked cover and title, independent menu, and one reserved credit line. */
export default function ResourceCell({
  primary, cover, title, metadata, controls, as: Root = "li", rootProps,
}: {
  readonly primary: { readonly href: string; readonly label?: string; readonly paneLabelHint?: string };
  readonly cover: ReactNode;
  readonly title: ReactNode;
  readonly metadata: ReactNode;
  readonly controls: ReactNode;
  readonly as?: "li" | "div";
  readonly rootProps?: HTMLAttributes<HTMLElement> & Partial<Record<`data-${string}`, string | boolean>>;
}) {
  return <Root {...rootProps} className={cx(styles.cell, rootProps?.className)}>
    <a href={primary.href} aria-label={primary.label} data-pane-label-hint={primary.paneLabelHint}
      data-row-focusable="" className={styles.primary}>
      <span className={styles.cover}>{cover}</span>
      <span className={styles.title} data-row-title="" dir="auto">{title}</span>
    </a>
    <div className={styles.controls}>{controls}</div>
    <div className={styles.metadata}>{metadata}</div>
  </Root>;
}
