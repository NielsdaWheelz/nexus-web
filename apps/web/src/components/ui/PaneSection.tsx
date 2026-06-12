import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSection.module.css";

interface PaneSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function PaneSection({
  title,
  description,
  actions,
  children,
  className,
}: PaneSectionProps) {
  return (
    <section className={cx(styles.section, className)}>
      {title || description || actions ? (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title ? <h2 className={styles.title}>{title}</h2> : null}
            {description ? (
              <p className={styles.description}>{description}</p>
            ) : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
