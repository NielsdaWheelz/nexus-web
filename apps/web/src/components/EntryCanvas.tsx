import type { ReactNode } from "react";
import styles from "./EntryCanvas.module.css";

interface EntryCanvasProps {
  readonly children: ReactNode;
}

export default function EntryCanvas({ children }: EntryCanvasProps) {
  return <div className={styles.canvas}>{children}</div>;
}
