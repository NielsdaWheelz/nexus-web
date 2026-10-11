"use client";

import { useId, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Toggle.module.css";

/** A switch: a visually hidden checkbox drawn as a track and thumb. */
export default function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  size = "md",
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  size?: "sm" | "md";
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <label
      className={cx(styles.root, styles[size], disabled && styles.disabled)}
      htmlFor={inputId}
    >
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
      {label}
    </label>
  );
}
