"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSurface.module.css";

interface PaneSurfaceProps {
  toolbar?: ReactNode;
  state?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export default function PaneSurface({
  toolbar,
  state,
  empty,
  footer,
  children,
  className,
}: PaneSurfaceProps) {
  const hasContent =
    children !== undefined && children !== null && children !== false;

  return (
    <div className={cx(styles.surface, className)}>
      {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      {state ? <div className={styles.state}>{state}</div> : null}
      {hasContent ? (
        <div className={styles.content}>{children}</div>
      ) : empty ? (
        <div className={styles.empty}>{empty}</div>
      ) : null}
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
