"use client";

import type { ReactNode } from "react";
import ActionMenu, { type ActionMenuOption } from "./ActionMenu";
import styles from "./SurfaceHeader.module.css";

export type SurfaceHeaderOption = ActionMenuOption;

interface SurfaceHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  options?: SurfaceHeaderOption[];
  headingLevel?: 1 | 2;
  className?: string;
}

export default function SurfaceHeader({
  title,
  subtitle,
  meta,
  actions,
  options = [],
  headingLevel = 2,
  className,
}: SurfaceHeaderProps) {
  const HeadingTag = headingLevel === 1 ? "h1" : "h2";
  const hasOptions = options.length > 0;
  const headerClassName = [styles.header, className].filter(Boolean).join(" ");

  return (
    <header className={headerClassName} data-surface-header="true">
      <div className={styles.leading}>
        <div className={styles.titles}>
          <HeadingTag className={styles.title}>{title}</HeadingTag>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>

      <div className={styles.trailing}>
        {actions && <div className={styles.actions}>{actions}</div>}

        {hasOptions && (
          <ActionMenu options={options} label="Options" className={styles.optionsContainer} />
        )}
      </div>
    </header>
  );
}
