"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import ResourceActivation, {
  type ResourceRowPrimary,
} from "./ResourceActivation";
import styles from "./ResourceRow.module.css";

type ResourceRowRootProps = HTMLAttributes<HTMLElement> &
  Partial<Record<`data-${string}`, string>>;

interface ResourceRowProps {
  readonly primary: ResourceRowPrimary;
  readonly title: ReactNode;
  readonly supporting?: ReactNode;
  readonly status?: ReactNode;
  readonly separateStatus?: boolean;
  readonly evidence?: ReactNode;
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
  separateStatus = true,
  evidence,
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
  const row = (
    <>
      <div className={styles.titleCell} data-view-transition-part="title">
        <ResourceActivation
          primary={primary}
          className={cx(
            styles.primary,
            primaryIsInteractive && styles.interactivePrimary,
          )}
        >
          <span className={styles.title} data-row-text dir="auto">
            {title}
          </span>
        </ResourceActivation>
      </div>
      {supporting || evidence || status ? (
        <div className={styles.secondary}>
          {supporting ? <div className={styles.supporting}>{supporting}</div> : null}
          {evidence ? <div className={styles.evidence}>{evidence}</div> : null}
          {supporting && status && separateStatus ? (
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
