"use client";

import styles from "./PaneStrip.module.css";

export default function PaneStrip({
  children,
  isMobile = false,
}: {
  children: React.ReactNode;
  isMobile?: boolean;
}) {
  return (
    <div
      className={styles.strip}
      data-testid="pane-strip"
      style={{
        display: "flex",
        flexDirection: "row",
        gap: "0",
        overflowX: isMobile ? "hidden" : "auto",
        overflowY: "hidden",
      }}
    >
      {children}
    </div>
  );
}
