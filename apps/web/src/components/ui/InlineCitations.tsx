/**
 * InlineCitations — compact numbered pills for message context references.
 *
 * Replaces the old messageContextBlock with lightweight colored pills [1][2]
 * that show a hover card with the highlight text and source.
 */

"use client";

import { useState } from "react";
import styles from "./InlineCitations.module.css";

interface ContextSnapshot {
  type: "highlight" | "annotation" | "media";
  id: string;
  color?: "yellow" | "green" | "blue" | "pink" | "purple";
  exact?: string;
  preview?: string;
  media_title?: string;
}

export default function InlineCitations({
  contexts,
}: {
  contexts: ContextSnapshot[];
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

function CitationCard({ context }: { context: ContextSnapshot }) {
  const text = context.exact || context.preview;
  return (
    <div className={styles.card}>
      {text && (
        <div className={styles.cardText}>
          {text.length > 120 ? text.slice(0, 120) + "..." : text}
        </div>
      )}
      {context.media_title && (
        <div className={styles.cardMeta}>{context.media_title}</div>
      )}
    </div>
  );
}
