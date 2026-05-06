/**
 * InlineCitations — compact numbered pills for message context references.
 *
 * Replaces the old messageContextBlock with lightweight colored pills [1][2]
 * that show a hover card with the highlight text and source.
 */

"use client";

import { useState } from "react";
import type { MessageContextSnapshot } from "@/lib/conversations/types";
import { truncateText } from "@/lib/conversations/display";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import styles from "./InlineCitations.module.css";

export default function InlineCitations({
  contexts,
  onReaderSourceActivate,
}: {
  contexts: MessageContextSnapshot[];
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <span className={styles.citations}>
      {contexts.map((ctx, i) => {
        const target = onReaderSourceActivate
          ? readerTargetFromContext(ctx)
          : null;
        const unavailable =
          Boolean(onReaderSourceActivate) &&
          ctx.kind === "reader_selection" &&
          target === null;
        const pillClassName = `${styles.pill} ${styles[`pill-${ctx.color ?? "neutral"}`]} ${
          unavailable ? styles.pillUnavailable : ""
        }`.trim();

        return (
          <span
            key={
              ctx.kind === "reader_selection"
                ? `reader-selection-${ctx.client_context_id ?? i}`
                : `${ctx.type}-${ctx.id}`
            }
            className={styles.pillWrapper}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            {target ? (
              <button
                type="button"
                className={`${pillClassName} ${styles.pillButton}`}
                onClick={() => onReaderSourceActivate?.(target)}
                aria-label={`Open citation ${i + 1}`}
              >
                {i + 1}
              </button>
            ) : (
              <span className={pillClassName}>{i + 1}</span>
            )}
            {hovered === i && <CitationCard context={ctx} />}
          </span>
        );
      })}
    </span>
  );
}

function readerTargetFromContext(context: MessageContextSnapshot): ReaderSourceTarget | null {
  if (context.kind !== "reader_selection") {
    return null;
  }
  const mediaId = context.source_media_id ?? context.media_id;
  if (!mediaId || !context.locator || Object.keys(context.locator).length === 0) {
    return null;
  }
  return {
    source: "message_context",
    media_id: mediaId,
    locator: context.locator,
    snippet: context.exact ?? context.preview ?? null,
    status: "attached_context",
    label: context.title ?? context.media_title,
    context_id: context.client_context_id ?? null,
  };
}

function CitationCard({ context }: { context: MessageContextSnapshot }) {
  const text = context.exact || context.preview;
  const title = context.title || context.media_title;
  const route = context.route;

  if (!text && !title && !route) {
    return null;
  }

  return (
    <div className={styles.card}>
      {title ? <div className={styles.cardTitle}>{truncateText(title, 96)}</div> : null}
      {text && (
        <div className={styles.cardText}>
          {truncateText(text, 120)}
        </div>
      )}
      {context.media_title && context.media_title !== title ? (
        <div className={styles.cardMeta}>{context.media_title}</div>
      ) : null}
      {route ? <div className={styles.cardMeta}>{route}</div> : null}
    </div>
  );
}
