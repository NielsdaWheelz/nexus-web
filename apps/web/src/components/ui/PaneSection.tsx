import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSection.module.css";

/** An open section of a pane body, with an optional header (title, description, actions). */
export default function PaneSection({
  title,
  description,
  actions,
  children,
  className,
  ...sectionProps
}: Omit<ComponentProps<"section">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
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
