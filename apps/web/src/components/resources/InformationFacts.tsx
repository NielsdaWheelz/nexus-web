import type { ReactNode } from "react";
import styles from "@/components/media/MediaInfoOverlay.module.css";

/** Information omits absent facts and empty groups, retaining confirmed zero. */
export function informationFact(label: string, value: ReactNode): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  return <div className={styles.fact} key={label}><dt>{label}</dt><dd>{value}</dd></div>;
}

export function informationGroup(title: string, facts: readonly ReactNode[]): ReactNode {
  if (facts.every(value => value === null)) return null;
  return <section className={styles.group} key={title}><h3>{title}</h3><dl>{facts}</dl></section>;
}
