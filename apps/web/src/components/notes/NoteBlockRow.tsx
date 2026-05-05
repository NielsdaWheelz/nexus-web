import type { ReactNode } from "react";
import styles from "./NoteBlockRow.module.css";

export default function NoteBlockRow({
  blockId,
  children,
}: {
  blockId: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.row} data-note-block-row={blockId}>
      <a className={styles.bullet} href={`/notes/${blockId}`} aria-label="Open note block" />
      <div className={styles.content}>{children}</div>
    </div>
  );
}
