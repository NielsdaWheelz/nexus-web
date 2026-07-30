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
  readonly primary: ResourceRowPrimary;
  readonly title: ReactNode;
  readonly supporting?: ReactNode;
  readonly status?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly actions?: ReactNode;
  readonly expanded?: ReactNode;
  readonly selected?: boolean;
  readonly as?: "li" | "div";
  readonly rootProps?: ResourceRowRootProps;
}

/**
 * Domain-free compact row geometry. Semantic projection and formatting belong
 * to the caller; this primitive only establishes visual and focus order.
 */
export default function ResourceRow({
  primary,
  title,
  supporting,
  status,
  primaryControl,
  actions,
  expanded,
  selected,
  as = "li",
  rootProps,
}: ResourceRowProps) {
  const primaryIsInteractive =
    primary.kind === "link" ||
    (primary.kind === "button" && !primary.disabled && !primary.busy);
  const titleContent = (
    <span className={styles.title} data-row-text dir="auto">
      {title}
    </span>
  );
  const row = (
    <>
      {primaryIsInteractive ? (
        <ResourceActivation
          primary={primary}
          className={cx(styles.primary, styles.interactivePrimary)}
        >
          {titleContent}
        </ResourceActivation>
      ) : null}
      {!primaryIsInteractive ? (
        <div className={styles.titleCell} data-view-transition-part="title">
          <ResourceActivation primary={primary} className={styles.primary}>
            {titleContent}
          </ResourceActivation>
        </div>
      ) : (
        <div
          className={styles.titleCell}
          data-view-transition-part="title"
          aria-hidden="true"
        >
          <span className={styles.title} dir="auto">
            {title}
          </span>
        </div>
      )}
      {supporting || status ? (
        <div className={styles.secondary}>
          {supporting ? <div className={styles.supporting}>{supporting}</div> : null}
          {supporting && status ? (
            <>
              <span className={styles.stateSeparator} aria-hidden="true">
                ·
              </span>
              <span className="sr-only">, </span>
            </>
          ) : null}
          {status ? <div className={styles.state}>{status}</div> : null}
        </div>
      ) : null}
      {primaryControl ? (
        <div className={styles.primaryControl}>{primaryControl}</div>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {expanded ? <div className={styles.expanded}>{expanded}</div> : null}
    </>
  );

  const rowClassName = cx(styles.row, selected && styles.selected);
  return as === "div" ? (
    <div className={rowClassName} {...rootProps}>
      {row}
    </div>
  ) : (
    <li className={rowClassName} {...rootProps}>
      {row}
    </li>
  );
}
