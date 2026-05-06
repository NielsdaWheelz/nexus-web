"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./Select.module.css";

type SelectSize = "sm" | "md" | "lg";

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: SelectSize;
}

const sizeClass: Record<SelectSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const iconSize: Record<SelectSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", className, children, ...rest },
  ref
) {
  const wrapperCls = [styles.wrapper, sizeClass[size], className ?? ""]
    .filter(Boolean)
    .join(" ");
  const selectCls = [styles.select, sizeClass[size]].join(" ");

  return (
    <div className={wrapperCls}>
      <select ref={ref} className={selectCls} {...rest}>
        {children}
      </select>
      <ChevronDown
        size={iconSize[size]}
        className={styles.chevron}
        aria-hidden="true"
      />
    </div>
  );
});

export default Select;
export type { SelectProps, SelectSize };
