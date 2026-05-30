"use client";

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { cx } from "@/lib/ui/cx";
import styles from "./ItemCard.module.css";

type ItemCardContent =
  | {
      kind: "highlight";
      prefix?: string | null;
      exact: string;
      suffix?: string | null;
      color: HighlightColor;
    }
  | { kind: "resource"; title: ReactNode; icon?: ReactNode };

interface ItemCardLinkedItem {
  id: string;
  icon?: ReactNode;
  label: string;
  onActivate: () => void;
}

interface ItemCardProps {
  content: ItemCardContent;
  meta?: ReactNode;
  actions?: ActionMenuOption[];
  note?: ReactNode;
  linkedItems?: ItemCardLinkedItem[];
  expanded?: boolean;
  selected?: boolean;
  onActivate?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  className?: string;
  highlightId?: string;
  testId?: string;
}

export default function ItemCard({
  content,
  meta,
  actions,
  note,
  linkedItems,
  expanded,
  selected,
  onActivate,
  onMouseEnter,
  onMouseLeave,
  rootRef,
  style,
  className,
  highlightId,
  testId,
}: ItemCardProps) {
  return (
    <div
      ref={rootRef}
      style={style}
      className={cx(styles.card, selected && styles.selected, expanded && styles.expanded, className)}
      data-highlight-id={highlightId}
      data-testid={testId}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (
          (event.target as HTMLElement).closest(
            'a, button, input, textarea, select, summary, [contenteditable="true"], .ProseMirror',
          )
        ) {
          return;
        }
        onActivate?.();
      }}
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.body}
          aria-pressed={selected}
          onClick={onActivate}
        >
          {content.kind === "highlight" ? (
            <HighlightSnippet
              prefix={content.prefix}
              exact={content.exact}
              suffix={content.suffix}
              color={content.color}
            />
          ) : (
            <>
              {content.icon}
              <span>{content.title}</span>
            </>
          )}
        </button>
        {actions?.length ? <ActionMenu options={actions} /> : null}
      </div>
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
      {linkedItems?.length ? (
        <details className={styles.linked}>
          <summary>{linkedItems.length} linked</summary>
          {linkedItems.map((item) => (
            <button key={item.id} type="button" onClick={item.onActivate}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </details>
      ) : null}
    </div>
  );
}
