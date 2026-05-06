"use client";

import type { ContextItem, ContextItemColor } from "@/lib/api/sse";
import { getContextChipLabel } from "@/lib/conversations/display";
import styles from "./ContextChips.module.css";

const COLOR_CLASS: Record<ContextItemColor, string> = {
  yellow: styles.chipSwatchYellow,
  green: styles.chipSwatchGreen,
  blue: styles.chipSwatchBlue,
  pink: styles.chipSwatchPink,
  purple: styles.chipSwatchPurple,
};

export default function ContextChips({
  contexts,
  onRemoveContext,
  maxContexts,
}: {
  contexts: ContextItem[];
  onRemoveContext?: (index: number) => void;
  maxContexts: number;
}) {
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={styles.contextChips}>
      {contexts.map((ctx, i) => (
        <span key={`${contextKey(ctx)}-${i}`} className={styles.contextChip}>
          {ctx.color ? (
            <span
              className={`${styles.chipSwatch} ${COLOR_CLASS[ctx.color]}`}
              aria-hidden="true"
            />
          ) : null}
          <span className={styles.chipText}>{getContextChipLabel(ctx)}</span>
          {onRemoveContext ? (
            <button
              type="button"
              className={styles.chipRemove}
              onClick={() => onRemoveContext(i)}
              aria-label="Remove context"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {contexts.length >= maxContexts ? (
        <span className={styles.contextChip}>Max {maxContexts} reached</span>
      ) : null}
    </div>
  );
}

function contextKey(context: ContextItem): string {
  if (context.kind === "reader_selection") {
    return `reader_selection-${context.client_context_id}`;
  }
  return `${context.type}-${context.id}`;
}
