"use client";

import styles from "./LecternNextPrompt.module.css";

/**
 * A single quiet line offered at the end of a document: "Next on the lectern:
 * <title>". Explicit tap only — no auto-advance (N-2). Presentational; the owner
 * supplies the tap behavior (remove finished item + open the next entry).
 */
export default function LecternNextPrompt({
  title,
  onSelect,
}: {
  title: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={styles.prompt} onClick={onSelect}>
      Next on the lectern: <span className={styles.title}>{title}</span>
    </button>
  );
}
