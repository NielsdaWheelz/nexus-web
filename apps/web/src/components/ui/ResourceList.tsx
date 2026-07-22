import type { ReactNode } from "react";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  ariaLabel: string;
  children: ReactNode;
}

export default function ResourceList({
  ariaLabel,
  children,
}: ResourceListProps) {
  return (
    <ul
      className={styles.list}
      aria-label={ariaLabel}
    >
      {children}
    </ul>
  );
}
