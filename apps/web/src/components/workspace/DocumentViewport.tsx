"use client";

import styles from "./DocumentViewport.module.css";

export default function DocumentViewport({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={styles.viewport}
      data-testid="document-viewport"
      data-pane-content="true"
      style={{ overflow: "auto" }}
    >
      {children}
    </div>
  );
}
