"use client";

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import { isNestedInteractiveTarget } from "@/lib/ui/isNestedInteractiveTarget";
import styles from "./ItemCard.module.css";

interface ItemCardProps {
  content: { title: ReactNode; icon?: ReactNode };
  meta?: ReactNode;
  actions?: ReactNode;
  unavailable?: boolean;
  onActivate: () => void;
}

export default function ItemCard({
  content,
  meta,
  actions,
  unavailable,
  onActivate,
}: ItemCardProps) {
  return (
    <div
      className={cx(styles.card, unavailable && styles.unavailable)}
      data-unavailable={unavailable ? "true" : undefined}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (unavailable) {
          return;
        }
        if (isNestedInteractiveTarget(event.target)) {
          return;
        }
        onActivate();
      }}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.body}
          disabled={unavailable}
          onClick={onActivate}
        >
          {content.icon}
          <span>{content.title}</span>
        </button>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {meta ? <div className={styles.meta}>{meta}</div> : null}
    </div>
  );
}
