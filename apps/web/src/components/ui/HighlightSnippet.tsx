"use client";

import styles from "./HighlightSnippet.module.css";

interface HighlightSnippetProps {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}

export default function HighlightSnippet({
  exact,
  prefix,
  suffix,
}: HighlightSnippetProps) {
  return (
    <span className={styles.root}>
      {prefix ? <span className={styles.prefix}>{prefix}</span> : null}
      {exact.trim() ? (
        <mark className={styles.exact}>{exact}</mark>
      ) : (
        <span className={styles.empty}>No selectable text</span>
      )}
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
    </span>
  );
}
