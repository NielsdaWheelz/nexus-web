import type { ReactNode } from "react";
import styles from "./SectionCard.module.css";

interface SectionCardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export default function SectionCard({
  title,
  description,
  actions,
  className,
  bodyClassName,
  children,
}: SectionCardProps) {
  return (
    <section className={`${styles.card} ${className ?? ""}`}>
      {(title || description || actions) && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {description && <p className={styles.description}>{description}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={`${styles.body} ${bodyClassName ?? ""}`}>{children}</div>
    </section>
  );
}
