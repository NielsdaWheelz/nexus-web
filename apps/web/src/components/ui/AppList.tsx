"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
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
  const handlePrimaryClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      !href ||
      event.defaultPrevented ||
      event.button !== 0 ||
      !event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    if (!requestOpenInAppPane(href)) {
      window.location.assign(href);
    }
  };

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
        <Link
          href={href}
          className={styles.primary}
          target={target}
          rel={rel}
          onClick={handlePrimaryClick}
        >
          {primaryContent}
        </Link>
      ) : (
        <div className={styles.primary}>{primaryContent}</div>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </li>
  );
}
