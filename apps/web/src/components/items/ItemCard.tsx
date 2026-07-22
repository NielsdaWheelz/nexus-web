"use client";

import { useRef } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import Button from "@/components/ui/Button";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { cx } from "@/lib/ui/cx";
import { isNestedInteractiveTarget } from "@/lib/ui/isNestedInteractiveTarget";
import { useClampWithToggle } from "@/lib/ui/useClampWithToggle";
import styles from "./ItemCard.module.css";

type ItemCardContent =
  | { kind: "highlight"; snippet: { exact: string; color: HighlightColor } }
  | { kind: "resource"; title: ReactNode; icon?: ReactNode };

interface ItemCardProps {
  content: ItemCardContent;
  meta?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  selected?: boolean;
  hovered?: boolean;
  unavailable?: boolean;
  showFullText?: boolean;
  onToggleFullText?: () => void;
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
  selected,
  hovered,
  unavailable,
  showFullText,
  onToggleFullText,
  onActivate,
  onMouseEnter,
  onMouseLeave,
  rootRef,
  style,
  className,
  highlightId,
  testId,
}: ItemCardProps) {
  // The card owns one narrow measurement: does its own clamped snippet overflow?
  // (Intent — which cards are expanded — is owned by the host.) Measure only while
  // collapsed; when expanded the box is un-clamped and would read as not overflowing.
  const bodyRef = useRef<HTMLButtonElement>(null);
  const snippetText =
    content.kind === "highlight" ? content.snippet.exact : null;
  const { overflowing } = useClampWithToggle({
    ref: bodyRef,
    text: snippetText,
    expanded: Boolean(showFullText),
  });

  const bodyContent =
    content.kind === "highlight" ? (
      <HighlightSnippet
        exact={content.snippet.exact}
        color={content.snippet.color}
        compact
      />
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
        unavailable && styles.unavailable,
        showFullText && styles.showFull,
        className,
      )}
      data-content-kind={content.kind}
      data-unavailable={unavailable ? "true" : undefined}
      data-highlight-id={highlightId}
      data-testid={testId}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (unavailable) {
          return;
        }
        if (isNestedInteractiveTarget(event.target)) {
          return;
        }
        onActivate?.();
      }}
    >
      <div className={styles.header}>
        {onActivate ? (
          <button
            ref={bodyRef}
            type="button"
            className={styles.body}
            aria-pressed={selected}
            disabled={unavailable}
            onClick={onActivate}
          >
            {bodyContent}
          </button>
        ) : (
          <div className={cx(styles.body, styles.staticBody)}>
            {bodyContent}
          </div>
        )}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {content.kind === "highlight" && (showFullText || overflowing) ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.showMoreToggle}
          leadingIcon={
            showFullText ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )
          }
          aria-expanded={showFullText}
          onClick={onToggleFullText}
        >
          {showFullText ? "Show less" : "Show more"}
        </Button>
      ) : null}
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
    </div>
  );
}
