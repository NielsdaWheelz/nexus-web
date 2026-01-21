"use client";

import styles from "./PaneContainer.module.css";

interface PaneContainerProps {
  children: React.ReactNode;
}

export default function PaneContainer({ children }: PaneContainerProps) {
  return <div className={styles.container}>{children}</div>;
}
