"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  label?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function ResourceList({
  label,
  description,
  footer,
  children,
  className,
}: ResourceListProps) {
  const list = (
    <ul className={cx(styles.list, className)} role="list">
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
