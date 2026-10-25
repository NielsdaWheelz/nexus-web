import type { ReactNode } from "react";
import styles from "./ResourceList.module.css";

/**
 * An editorial index: rows butt together, separated by their own hairlines.
 * Full-width direct and sortable rows share this list's query container;
 * standalone rows keep their own.
 */
export default function ResourceList({
  ariaLabel,
  busy,
  children,
}: {
  ariaLabel: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <ul className={styles.list} data-resource-list="" aria-label={ariaLabel} aria-busy={busy}>
      {children}
    </ul>
  );
}
