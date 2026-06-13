"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./ResourceRow.module.css";

type ResourceRowPrimary =
  | {
      kind: "link";
      href: string;
      paneTitleHint?: string;
      target?: "_self" | "_blank";
      rel?: string;
    }
  | {
      kind: "button";
      onActivate: () => void | Promise<void>;
      disabled?: boolean;
      busy?: boolean;
      label: string;
    }
  | { kind: "static" };

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
  actions?: ReactNode;
  expanded?: ReactNode;
  selected?: boolean;
  className?: string;
  as?: "li" | "div";
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
  actions,
  expanded,
  selected,
  className,
  as = "li",
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
        <span className={styles.title}>{title}</span>
        {description ? (
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

  const primaryNode =
    primary.kind === "link" ? (
      <a
        className={primaryClassName}
        href={primary.href}
        data-pane-title-hint={primary.paneTitleHint}
        target={primary.target}
        rel={primary.rel}
      >
        {content}
      </a>
    ) : primary.kind === "button" ? (
      <button
        className={primaryClassName}
        type="button"
        disabled={primary.disabled || primary.busy}
        aria-busy={primary.busy || undefined}
        aria-label={primary.label}
        onClick={() => {
          void primary.onActivate();
        }}
      >
        {content}
      </button>
    ) : (
      <div className={primaryClassName}>{content}</div>
    );

  const row = (
    <>
      <div className={styles.main}>{primaryNode}</div>
      {contributors || actions ? (
        <div className={styles.side}>
          {contributors ? (
            <div className={styles.contributors}>{contributors}</div>
          ) : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {expanded ? <div className={styles.expanded}>{expanded}</div> : null}
    </>
  );

  const rowClassName = cx(styles.row, selected && styles.selected, className);
  return as === "div" ? (
    <div className={rowClassName}>{row}</div>
  ) : (
    <li className={rowClassName}>{row}</li>
  );
}
