import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSection.module.css";

interface PaneSectionProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export default function PaneSection({
  title,
  description,
  actions,
  children,
  className,
  ...sectionProps
}: PaneSectionProps) {
  return (
    <section {...sectionProps} className={cx(styles.section, className)}>
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
