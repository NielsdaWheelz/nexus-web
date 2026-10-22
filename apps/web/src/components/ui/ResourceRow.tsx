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
      ref?: Ref<HTMLAnchorElement>;
    }
  | {
      kind: "button";
      onActivate: (triggerElement: HTMLButtonElement) => void | Promise<void>;
      disabled?: boolean;
      busy?: boolean;
      label: string;
    }
  | { kind: "static" };

/** Ordinary index geometry; title navigation stays native and controls are separate. */
export default function ResourceRow({
  primary,
  title,
  supporting,
  status,
  evidence,
  leadingVisual,
  primaryControl,
  actions,
  expanded,
  selected,
  wrapped = false,
  as: Root = "li",
  rootProps,
  media = false,
}: {
  readonly media?: boolean;
  readonly primary: ResourceRowPrimary;
  readonly title: ReactNode;
  readonly supporting?: ReactNode;
  readonly status?: ReactNode;
  readonly evidence?: ReactNode;
  readonly leadingVisual?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly actions?: ReactNode;
  readonly expanded?: ReactNode;
  readonly selected?: boolean;
  readonly wrapped?: boolean;
  readonly as?: "li" | "div";
  readonly rootProps?: HTMLAttributes<HTMLElement> &
    Partial<Record<`data-${string}`, string | boolean>>;
}) {
  if (media) return (
    <Root
      {...rootProps}
      className={cx(styles.mediaRow, styles.mediaCollection, selected && styles.selected, rootProps?.className)}
    >
      <div className={cx(styles.mediaGrid, !leadingVisual && styles.mediaWithoutLeading)}>
        {leadingVisual ? <div className={styles.mediaLeading}>{leadingVisual}</div> : null}
        <div className={styles.mediaContent}>
          <div className={styles.mediaTitle} data-row-title="" dir="auto">
            {primary.kind === "link" ? (
              <a
                ref={primary.ref}
                href={primary.href}
                data-row-focusable=""
                data-pane-label-hint={primary.paneLabelHint}
                target={primary.target}
                rel={primary.rel}
              >
                {title}
              </a>
            ) : title}
          </div>
          {supporting}{evidence}{status}
        </div>
        <div className={styles.mediaControls}>{primaryControl}{actions}</div>
        {expanded ? <div className={styles.mediaExpanded} data-row-expanded="">{expanded}</div> : null}
      </div>
    </Root>
  );
  const label = (
    <span className={styles.title} data-row-title="" dir="auto">
      {title}
    </span>
  );
  return (
    <Root
      className={cx(
        styles.row,
        Boolean(leadingVisual) && styles.withVisual,
        wrapped && styles.wrapped,
        selected && styles.selected,
      )}
      {...rootProps}
    >
      {leadingVisual ? (
        <div className={styles.leadingVisual}>{leadingVisual}</div>
      ) : null}
      <div className={styles.titleCell}>
        {primary.kind === "link" ? (
          <a
            ref={primary.ref}
            className={styles.primary}
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
            className={styles.primary}
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
          <div className={styles.primary}>{label}</div>
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
      {expanded ? <div className={styles.expanded} data-row-expanded="">{expanded}</div> : null}
    </Root>
  );
}
