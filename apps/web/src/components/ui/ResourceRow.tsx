"use client";

import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "@/lib/ui/cx";
import { assertNever } from "@/lib/assertNever";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./ResourceRow.module.css";

/** What activating the row does: follow a link, run a command, or nothing. */
export type ResourceRowPrimary =
  | {
      kind: "link";
      href: string | null;
      label?: string;
      onActivate?: (event: TargetActivationEvent) => void;
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

type RowContent =
  | { kind: "Index"; metadata: ReactNode }
  | { kind: "Search"; metadata: ReactNode; excerpt: ReactNode }
  | { kind: "Details"; body: ReactNode };

/**
 * One index geometry: two reserved text lines, or three for search. Details alone
 * wrap operational content. Width adaptation belongs to this named container;
 * native title navigation, passive artwork and independent controls keep owners.
 */
export default function ResourceRow({
  primary, title, content, leadingVisual, controls, selected, as: Root = "li", rootProps,
}: {
  readonly primary: ResourceRowPrimary;
  readonly title: ReactNode;
  readonly content: RowContent;
  readonly leadingVisual?: ReactNode;
  readonly controls?: ReactNode;
  readonly selected?: boolean;
  readonly as?: "li" | "div";
  readonly rootProps?: HTMLAttributes<HTMLElement> & Partial<Record<`data-${string}`, string | boolean>>;
}) {
  const label = <span className={styles.title} data-row-title="" dir="auto">{title}</span>;
  let activation: ReactNode;
  switch (primary.kind) {
    case "link": activation = <a
      ref={primary.ref} className={styles.primary} data-row-focusable=""
      href={primary.href ?? undefined} data-pane-label-hint={primary.paneLabelHint}
      role={primary.href === null ? "link" : undefined} tabIndex={primary.href === null ? 0 : undefined}
      aria-label={primary.label}
      data-workspace-rich-target={primary.onActivate ? "true" : undefined}
      onClick={primary.onActivate} onKeyDown={primary.onActivate}
      target={primary.target} rel={primary.rel}
    >{label}</a>; break;
    case "button": activation = <button
      type="button" className={styles.primary} data-row-focusable=""
      disabled={primary.disabled || primary.busy} aria-busy={primary.busy || undefined}
      aria-label={primary.label}
      onClick={(event) => {
        if (!isInteractiveTarget(event.target, event.currentTarget)) void primary.onActivate(event.currentTarget);
      }}
    >{label}</button>; break;
    case "static": activation = <div className={styles.primary}>{label}</div>; break;
    default: assertNever(primary);
  }
  let secondary: ReactNode;
  switch (content.kind) {
    case "Details": secondary = <div className={styles.body} data-row-expanded="">{content.body}</div>; break;
    case "Index":
    case "Search": secondary = <>
      <div className={styles.metadata}>{content.metadata}</div>
      {content.kind === "Search" ? <div className={styles.excerpt}>{content.excerpt}</div> : null}
    </>; break;
    default: assertNever(content);
  }
  return <Root {...rootProps} className={cx(styles.row, selected && styles.selected, rootProps?.className)}>
    <div className={cx(styles.grid, Boolean(leadingVisual) && styles.withVisual, content.kind === "Details" && styles.details)}>
      {leadingVisual ? <div className={styles.leadingVisual}>{leadingVisual}</div> : null}
      <div className={styles.content}>
        <div className={styles.titleLine}>{activation}</div>
        {secondary}
      </div>
      {controls ? <div className={styles.controls}>{controls}</div> : null}
    </div>
  </Root>;
}
