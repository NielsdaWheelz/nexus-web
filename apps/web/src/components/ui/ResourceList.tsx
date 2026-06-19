"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import { useCollectionKeyboard } from "@/lib/ui/useCollectionKeyboard";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  label?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  view?: "list" | "gallery";
  density?: "comfortable" | "compact";
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
}

export default function ResourceList({
  label,
  description,
  footer,
  view = "list",
  density = "comfortable",
  ariaLabel,
  children,
  className,
}: ResourceListProps) {
  const { containerRef, onFocus, onKeyDown } = useCollectionKeyboard();
  const list = (
    <ul
      ref={containerRef}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className={cx(styles.list, className)}
      role="list"
      aria-label={ariaLabel}
      data-view={view}
      data-density={density}
    >
      {children}
    </ul>
  );

  if (!label && !description && !footer) {
    return list;
  }

  return (
    <section className={styles.section}>
      {label || description ? (
        <header className={styles.header}>
          {label ? <h2 className={styles.label}>{label}</h2> : null}
          {description ? (
            <p className={styles.description}>{description}</p>
          ) : null}
        </header>
      ) : null}
      {list}
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </section>
  );
}
