"use client";

import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "@/lib/ui/cx";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import styles from "./ResourceRow.module.css";

/** What activating the row does: follow a link, run a command, or nothing. */
export type ResourceRowPrimary =
  | {
      kind: "link";
      href: string;
      paneLabelHint?: string;
      target?: "_self" | "_blank";
      rel?: string;
    }
  | {
      kind: "button";
      onActivate: (triggerElement: HTMLButtonElement) => void | Promise<void>;
      disabled?: boolean;
      busy?: boolean;
      label: string;
    }
  | { kind: "static" };

/**
 * A list row, clickable anywhere: an interactive primary stretches over the
 * row while nested controls stay live above it. Status sits beside the title;
 * `wrapped` lets supporting text, status, evidence and the panel take full lines.
 * Domain projection and formatting belong to the caller.
 */
export default function ResourceRow({
  primary,
  title,
  supporting,
  status,
  evidence,
  leadingControl,
  primaryControl,
  actions,
  expanded,
  selected,
  wrapped = false,
  as: Root = "li",
  rootProps,
  rowRef,
  outline,
}: {
  readonly primary: ResourceRowPrimary;
  readonly title: ReactNode;
  readonly supporting?: ReactNode;
  readonly status?: ReactNode;
  readonly evidence?: ReactNode;
  readonly leadingControl?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly actions?: ReactNode;
  readonly expanded?: ReactNode;
  readonly selected?: boolean;
  readonly wrapped?: boolean;
  readonly as?: "li" | "div";
  readonly rootProps?: HTMLAttributes<HTMLElement> &
    Partial<Record<`data-${string}`, string | boolean>>;
  readonly rowRef?: Ref<HTMLLIElement>;
  readonly outline?: { controls: ReactNode; body: ReactNode };
}) {
  // justify-type-assertion: the selected native root receives the same DOM ref.
  if (outline)
    return (
      <Root
        {...rootProps}
        ref={rowRef as Ref<HTMLLIElement & HTMLDivElement>}
        className={cx(styles.outlineRow, rootProps?.className)}
      >
        <div className={styles.outlineHead}>
          {outline.controls}
          <div className={styles.outlineBody}>{outline.body}</div>
          {primaryControl}
          {actions}
        </div>
        {expanded}
      </Root>
    );
  const interactive =
    primary.kind === "link" ||
    (primary.kind === "button" && !primary.disabled && !primary.busy);
  const className = cx(styles.primary, interactive && styles.stretched);
  const label = (
    <span className={styles.title} data-row-title="" dir="auto">
      {title}
    </span>
  );
  return (
    <Root
      ref={rowRef as Ref<HTMLLIElement & HTMLDivElement>}
      className={cx(
        styles.row,
        Boolean(leadingControl) && styles.withLeading,
        wrapped && styles.wrapped,
        selected && styles.selected,
      )}
      {...rootProps}
    >
      {leadingControl ? (
        <div className={styles.leadingControl}>{leadingControl}</div>
      ) : null}
      <div className={styles.titleCell}>
        {primary.kind === "link" ? (
          <a
            className={className}
            data-row-focusable=""
            href={primary.href}
            data-pane-label-hint={primary.paneLabelHint}
            target={primary.target}
            rel={primary.rel}
          >
            {label}
          </a>
        ) : primary.kind === "button" ? (
          <button
            type="button"
            className={className}
            data-row-focusable=""
            disabled={primary.disabled || primary.busy}
            aria-busy={primary.busy || undefined}
            aria-label={primary.label}
            onClick={(event) => {
              if (!isInteractiveTarget(event.target, event.currentTarget))
                void primary.onActivate(event.currentTarget);
            }}
          >
            {label}
          </button>
        ) : (
          <div className={className}>{label}</div>
        )}
      </div>
      {supporting || evidence || status ? (
        <div className={styles.secondary}>
          {supporting ? (
            <div className={styles.supporting}>{supporting}</div>
          ) : null}
          {evidence ? <div className={styles.evidence}>{evidence}</div> : null}
          {supporting && status && !wrapped ? (
            <>
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
              <span className="sr-only">, </span>
            </>
          ) : null}
          {status ? <div className={styles.status}>{status}</div> : null}
        </div>
      ) : null}
      {primaryControl ? (
        <div className={styles.primaryControl} data-row-primary-control="">
          {primaryControl}
        </div>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {expanded ? <div className={styles.expanded}>{expanded}</div> : null}
    </Root>
  );
}
