"use client";

import type { HighlightColor } from "@/lib/highlights";
import styles from "./HighlightSnippet.module.css";

export type HighlightSnippetColor = HighlightColor | "neutral";

interface HighlightSnippetProps {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  color?: HighlightSnippetColor;
  compact?: boolean;
  className?: string;
}

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(" ");
}

export default function HighlightSnippet({
  exact,
  prefix,
  suffix,
  color = "neutral",
  compact = false,
  className,
}: HighlightSnippetProps) {
  return (
    <span className={cx(styles.root, compact && styles.compact, className)}>
      {!compact && prefix ? <span className={styles.prefix}>{prefix}</span> : null}
      <mark className={cx(styles.exact, styles[`color-${color}`])}>{exact}</mark>
      {!compact && suffix ? <span className={styles.suffix}>{suffix}</span> : null}
    </span>
  );
}
