import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./AppList.module.css";

interface AppListProps {
  children: ReactNode;
}

interface AppListItemProps {
  href?: string;
  target?: string;
  rel?: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
}

export function AppList({ children }: AppListProps) {
  return <ul className={styles.list}>{children}</ul>;
}

export function AppListItem({
  href,
  target,
  rel,
  title,
  description,
  meta,
  icon,
  trailing,
  actions,
}: AppListItemProps) {
  const primaryContent = (
    <>
      {icon && <span className={styles.icon}>{icon}</span>}
      <div className={styles.content}>
        <span className={styles.title}>{title}</span>
        {description && <span className={styles.description}>{description}</span>}
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </>
  );

  return (
    <li className={styles.item}>
      {href ? (
        <Link href={href} className={styles.primary} target={target} rel={rel}>
          {primaryContent}
        </Link>
      ) : (
        <div className={styles.primary}>{primaryContent}</div>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </li>
  );
}
