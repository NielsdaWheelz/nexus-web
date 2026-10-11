import type { ComponentProps } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Pill.module.css";

export type PillTone =
  "neutral" | "info" | "success" | "warning" | "danger" | "accent";

/** A tone-tinted uppercase label; `xs` is a count in icon-only chrome. */
export default function Pill({
  tone = "neutral",
  size = "sm",
  className,
  children,
  ...rest
}: ComponentProps<"span"> & { tone?: PillTone; size?: "xs" | "sm" }) {
  return (
    <span
      className={cx(styles.pill, styles[tone], styles[size], className)}
      {...rest}
    >
      <span className={styles.label}>{children}</span>
    </span>
  );
}
