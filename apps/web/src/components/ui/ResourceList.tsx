import type { ReactNode, Ref } from "react";
import styles from "./ResourceList.module.css";

/** An editorial index: rows butt together, separated by their own hairlines. */
export default function ResourceList({
  ariaLabel,
  busy,
  children,
  ref,
  windowed = false,
  measuring = false,
}: {
  ariaLabel: string;
  busy?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLUListElement>;
  windowed?: boolean;
  measuring?: boolean;
}) {
  return (
    <ul ref={ref} className={styles.list} aria-label={ariaLabel} aria-busy={busy} data-index-window={windowed || undefined}
      inert={measuring || undefined} aria-hidden={measuring || undefined} style={measuring ? { visibility: "hidden" } : undefined}>
      {children}
    </ul>
  );
}
