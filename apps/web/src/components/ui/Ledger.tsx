import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Ledger.module.css";

/** Facts beside a quiet side-head; the caller sets the label measure with --ledger-label. */
export function Ledger({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <dl className={cx(styles.ledger, className)}>{children}</dl>;
}

export function LedgerLine({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return <div className={styles.line}><dt>{label}</dt><dd>{children}</dd></div>;
}
