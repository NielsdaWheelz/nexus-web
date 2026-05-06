"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import styles from "./Input.module.css";

type InputVariant = "default" | "bare";
type InputSize = "sm" | "md" | "lg";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  variant?: InputVariant;
  size?: InputSize;
}

const variantClass: Record<InputVariant, string> = {
  default: styles.default,
  bare: styles.bare,
};

const sizeClass: Record<InputSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { variant = "default", size = "md", className, type, ...rest },
  ref
) {
  const cls = [styles.input, variantClass[variant], sizeClass[size], className ?? ""]
    .filter(Boolean)
    .join(" ");

  return <input ref={ref} type={type ?? "text"} className={cls} {...rest} />;
});

export default Input;
export type { InputProps, InputVariant, InputSize };
