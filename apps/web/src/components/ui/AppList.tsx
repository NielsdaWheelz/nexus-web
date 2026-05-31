"use client";

import type { ReactNode } from "react";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import ContextRow from "@/components/ui/ContextRow";
import styles from "./AppList.module.css";

interface AppListProps {
  children: ReactNode;
}

interface AppListItemProps {
  href?: string;
  target?: string;
  rel?: string;
  title: ReactNode;
  paneTitleHint?: string;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  options?: ActionMenuOption[];
}

export function AppList({ children }: AppListProps) {
  return <ul className={styles.list}>{children}</ul>;
}

export function AppListItem({
  href,
  target,
  rel,
  title,
  paneTitleHint,
  description,
  meta,
  icon,
  trailing,
  actions,
  options,
}: AppListItemProps) {
  const resolvedPaneTitleHint =
    paneTitleHint ?? (typeof title === "string" ? title : undefined);

  const hasMenu = options && options.length > 0;
  const resolvedActions =
    (actions || hasMenu) ? (
      <>
        {actions}
        {hasMenu && <ActionMenu options={options} className={styles.actionMenu} />}
      </>
    ) : undefined;

  const primaryContent = (
    <ContextRow
      className={styles.row}
      href={href}
      paneTitleHint={resolvedPaneTitleHint}
      target={target}
      rel={rel}
      mainClassName={styles.primary}
      leadingClassName={styles.icon}
      contentClassName={styles.content}
      titleClassName={styles.title}
      descriptionClassName={styles.description}
      metaClassName={styles.meta}
      trailingClassName={styles.trailing}
      actionsClassName={styles.actions}
      leading={icon}
      title={title}
      description={description}
      meta={meta}
      trailing={trailing}
      actions={resolvedActions}
    />
  );

  return (
    <li className={styles.item}>
      {primaryContent}
    </li>
  );
}
