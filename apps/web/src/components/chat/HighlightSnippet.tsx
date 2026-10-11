import styles from "./HighlightSnippet.module.css";

/** A quoted passage: its context dimmed around the marked exact text. */
export default function HighlightSnippet({
  exact,
  prefix,
  suffix,
}: {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}) {
  return (
    <span className={styles.root}>
      {prefix ? <span className={styles.context}>{prefix}</span> : null}
      {exact.trim() ? (
        <mark className={styles.exact}>{exact}</mark>
      ) : (
        <span className={styles.empty}>No selectable text</span>
      )}
      {suffix ? <span className={styles.context}>{suffix}</span> : null}
    </span>
  );
}
