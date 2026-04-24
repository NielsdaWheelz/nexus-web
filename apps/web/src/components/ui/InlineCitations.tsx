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
import styles from "./InlineCitations.module.css";

export default function InlineCitations({
  contexts,
}: {
  contexts: MessageContextSnapshot[];
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <span className={styles.citations}>
      {contexts.map((ctx, i) => (
        <span key={`${ctx.type}-${ctx.id}`} className={styles.pillWrapper}>
          <span
            className={`${styles.pill} ${styles[`pill-${ctx.color ?? "neutral"}`]}`}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            {i + 1}
          </span>
          {hovered === i && <CitationCard context={ctx} />}
        </span>
      ))}
    </span>
  );
}

function CitationCard({ context }: { context: MessageContextSnapshot }) {
  const text = context.exact || context.preview;
  return (
    <div className={styles.card}>
      {text && (
        <div className={styles.cardText}>
          {truncateText(text, 120)}
        </div>
      )}
      {context.media_title && (
        <div className={styles.cardMeta}>{context.media_title}</div>
      )}
    </div>
  );
}
