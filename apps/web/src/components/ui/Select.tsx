import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Field.module.css";

export type SelectSize = "sm" | "md" | "lg";

/** A native select with the field appearance and a chevron. */
export default function Select({
  size = "md",
  className,
  children,
  ...rest
}: Omit<ComponentProps<"select">, "size"> & { size?: SelectSize }) {
  return (
    <div className={cx(styles.selectWrap, styles[size], className)}>
      <select
        className={cx(styles.field, styles.boxed, styles.select, styles[size])}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={{ sm: 14, md: 16, lg: 18 }[size]}
        className={styles.chevron}
        aria-hidden="true"
      />
    </div>
  );
}
