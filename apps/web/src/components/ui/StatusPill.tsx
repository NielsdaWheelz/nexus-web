import type { ReactNode } from "react";
import styles from "./StatusPill.module.css";

type StatusPillVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

interface StatusPillProps {
  variant: StatusPillVariant;
  children: ReactNode;
}

export default function StatusPill({ variant, children }: StatusPillProps) {
  return <span className={`${styles.pill} ${styles[variant]}`}>{children}</span>;
}
