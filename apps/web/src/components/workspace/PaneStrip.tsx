"use client";

import styles from "./PaneStrip.module.css";

export default function PaneStrip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={styles.strip}
      data-testid="pane-strip"
      style={{
        display: "flex",
        flexDirection: "row",
        gap: "0",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {children}
    </div>
  );
}
