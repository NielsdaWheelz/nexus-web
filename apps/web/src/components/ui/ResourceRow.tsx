"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import ResourceActivation, {
  type ResourceRowPrimary,
} from "./ResourceActivation";
import styles from "./ResourceRow.module.css";

type ResourceRowRootProps = HTMLAttributes<HTMLElement> &
  Partial<Record<`data-${string}`, string>>;

export type { ResourceRowPrimary };

interface ResourceRowProps {
  primary: ResourceRowPrimary;
  title: ReactNode;
  eyebrow?: ReactNode;
  badges?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  contributors?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  secondary?: ReactNode;
  actions?: ReactNode;
  expanded?: ReactNode;
  selected?: boolean;
  density?: "comfortable" | "compact";
  className?: string;
  as?: "li" | "div";
  actionsVisibility?: "hover" | "always";
  /** Forwarded to the row root — used for swipe (transform + pointer handlers). */
  rootProps?: ResourceRowRootProps;
}

export default function ResourceRow({
  primary,
  title,
  eyebrow,
  badges,
  description,
  meta,
  contributors,
  leading,
  trailing,
  secondary,
  actions,
  expanded,
  selected,
  density = "comfortable",
  className,
  as = "li",
  actionsVisibility = "hover",
  rootProps,
}: ResourceRowProps) {
  const content = (
    <>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.copy}>
        {eyebrow || badges ? (
          <span className={styles.eyebrow}>
            {eyebrow}
            {badges}
          </span>
        ) : null}
        <span className={styles.title} data-row-text data-view-transition-part="title">
          {title}
        </span>
        {description && density !== "compact" ? (
          <span className={styles.description}>{description}</span>
        ) : null}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </>
  );

  const primaryClassName = cx(
    styles.primary,
    primary.kind === "static" && styles.staticPrimary,
  );

  const primaryNode = (
    <ResourceActivation primary={primary} className={primaryClassName}>
      {content}
    </ResourceActivation>
  );

  const row = (
    <>
      <div className={styles.main}>{primaryNode}</div>
      {secondary || contributors || actions ? (
        <div className={styles.side}>
          {secondary ? <div className={styles.secondary}>{secondary}</div> : null}
          {contributors ? (
            <div className={styles.contributors}>{contributors}</div>
          ) : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {expanded ? <div className={styles.expanded}>{expanded}</div> : null}
    </>
  );

  const rowClassName = cx(
    styles.row,
    actionsVisibility === "always" && styles.actionsAlwaysVisible,
    selected && styles.selected,
    className,
  );
  return as === "div" ? (
    <div className={rowClassName} data-density={density} {...rootProps}>
      {row}
    </div>
  ) : (
    <li className={rowClassName} data-density={density} {...rootProps}>
      {row}
    </li>
  );
}
