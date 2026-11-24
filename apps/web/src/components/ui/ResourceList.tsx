import type { ReactNode, Ref } from "react";
import styles from "./ResourceList.module.css";

/** Nonsticky headings share the list's measure without becoming selectable rows. */
export function ResourceListHead({ children, sampleFor, before }: { readonly children: ReactNode; readonly sampleFor?: string; readonly before?: string }) {
  return <li role="presentation" data-index-head-before={before} data-index-head-sample={sampleFor} inert={sampleFor !== undefined || undefined} aria-hidden={sampleFor !== undefined || undefined}
    className={sampleFor === undefined ? styles.head : `${styles.head} ${styles.headSample}`}>{children}</li>;
}

/** An editorial index: rows butt together, separated by their own hairlines. */
export default function ResourceList({
  ariaLabel,
  busy,
  children,
  ref,
  windowed = false,
  measuring = false,
  held = false,
}: {
  ariaLabel: string;
  busy?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLUListElement>;
  windowed?: boolean;
  measuring?: boolean;
  held?: boolean;
}) {
  return (
    <ul ref={ref} className={styles.list} aria-label={ariaLabel} aria-busy={busy} data-index-window={windowed || undefined} data-index-held={held || undefined}
      inert={measuring || undefined} aria-hidden={measuring || undefined} style={measuring ? { visibility: "hidden" } : undefined}>
      {children}
    </ul>
  );
}
