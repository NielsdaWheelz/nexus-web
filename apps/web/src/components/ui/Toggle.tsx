"use client";

import { useId, type ReactNode } from "react";
import styles from "./Toggle.module.css";

type ToggleSize = "sm" | "md";

interface ToggleProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  size?: ToggleSize;
}

const sizeClass: Record<ToggleSize, string> = {
  sm: styles.sm,
  md: styles.md,
};

export default function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  size = "md",
}: ToggleProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const rootClass = [styles.root, sizeClass[size], disabled ? styles.disabled : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={rootClass} htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        className={`${styles.input} sr-only`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {label !== undefined ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}

export type { ToggleProps, ToggleSize };
