"use client";

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import Disclosure from "@/components/ui/Disclosure";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { cx } from "@/lib/ui/cx";
import styles from "./ItemCard.module.css";

type ItemCardContent =
  | { kind: "highlight"; snippet: { exact: string; color: HighlightColor } }
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
  linkedItemsSummary?: ReactNode;
  expanded?: boolean;
  selected?: boolean;
  hovered?: boolean;
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
  linkedItemsSummary,
  expanded,
  selected,
  hovered,
  onActivate,
  onMouseEnter,
  onMouseLeave,
  rootRef,
  style,
  className,
  highlightId,
  testId,
}: ItemCardProps) {
  const bodyContent =
    content.kind === "highlight" ? (
      <HighlightSnippet exact={content.snippet.exact} color={content.snippet.color} compact />
    ) : (
      <>
        {content.icon}
        <span>{content.title}</span>
      </>
    );

  return (
    <div
      ref={rootRef}
      style={style}
      className={cx(
        styles.card,
        selected && styles.selected,
        hovered && styles.hovered,
        expanded && styles.expanded,
        className,
      )}
      data-content-kind={content.kind}
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
        {onActivate ? (
          <button
            type="button"
            className={styles.body}
            aria-pressed={selected}
            onClick={onActivate}
          >
            {bodyContent}
          </button>
        ) : (
          <div className={cx(styles.body, styles.staticBody)}>{bodyContent}</div>
        )}
        {actions?.length ? <ActionMenu options={actions} /> : null}
      </div>
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
      {linkedItems?.length ? (
        <Disclosure
          className={styles.linked}
          summary={linkedItemsSummary ?? `${linkedItems.length} linked`}
        >
          {linkedItems.map((item) => (
            <button key={item.id} type="button" onClick={item.onActivate}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </Disclosure>
      ) : null}
    </div>
  );
}
