import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import type { ReactNode } from "react";
import styles from "./ResourceList.module.css";

/** An editorial index: rows butt together, separated by their own hairlines. */
export default function ResourceList({
  ariaLabel,
  busy,
  children,
  scope,
}: {
  ariaLabel: string;
  busy?: boolean;
  children: ReactNode;
  scope?:string;
}) {
  if (scope) return <ResourceOutlineList scope={scope} ariaLabel={ariaLabel} busy={busy}>{children}</ResourceOutlineList>;
  return (
    <ul className={styles.list} aria-label={ariaLabel} aria-busy={busy}>
      {children}
    </ul>
  );
}
