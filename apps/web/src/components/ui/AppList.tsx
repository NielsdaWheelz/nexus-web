"use client";

import type { MouseEvent, ReactNode } from "react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
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
  status?: "success" | "info" | "warning" | "danger" | "neutral";
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
  status,
}: AppListItemProps) {
  const resolvedPaneTitleHint =
    paneTitleHint ?? (typeof title === "string" ? title : undefined);

  const handlePrimaryClick = (event: MouseEvent<HTMLElement>) => {
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
    if (!requestOpenInAppPane(href, { titleHint: resolvedPaneTitleHint })) {
      window.location.assign(href);
    }
  };

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
      target={target}
      rel={rel}
      onMainClick={href ? handlePrimaryClick : undefined}
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
    <li className={styles.item} data-status={status}>
      {primaryContent}
    </li>
  );
}
