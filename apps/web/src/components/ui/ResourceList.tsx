import type { ReactNode } from "react";
import styles from "./ResourceList.module.css";

interface ResourceListProps {
  ariaLabel: string;
  busy?: boolean;
  children: ReactNode;
}

export default function ResourceList({
  ariaLabel,
  busy,
  children,
}: ResourceListProps) {
  return (
    <ul
      className={styles.list}
      aria-label={ariaLabel}
      aria-busy={busy}
    >
      {children}
    </ul>
  );
}
