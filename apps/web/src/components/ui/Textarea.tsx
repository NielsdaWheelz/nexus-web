"use client";

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";
import styles from "./Textarea.module.css";

type TextareaVariant = "default" | "bare";
type TextareaSize = "sm" | "md" | "lg";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: TextareaVariant;
  size?: TextareaSize;
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
}

const variantClass: Record<TextareaVariant, string> = {
  default: styles.default,
  bare: styles.bare,
};

const sizeClass: Record<TextareaSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    variant = "default",
    size = "md",
    autoGrow = false,
    minRows = 3,
    maxRows = 12,
    className,
    rows,
    value,
    defaultValue,
    ...rest
  },
  ref
) {
  const innerRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, []);

  useLayoutEffect(() => {
    if (!autoGrow) return;
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 0;
    const verticalPadding =
      parseFloat(getComputedStyle(el).paddingTop) +
      parseFloat(getComputedStyle(el).paddingBottom);
    const max = lineHeight > 0 ? lineHeight * maxRows + verticalPadding : Infinity;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [autoGrow, maxRows, value]);

  const cls = [
    styles.textarea,
    variantClass[variant],
    sizeClass[size],
    autoGrow ? styles.autoGrow : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <textarea
      ref={innerRef}
      className={cls}
      rows={rows ?? minRows}
      value={value}
      defaultValue={defaultValue}
      {...rest}
    />
  );
});

export default Textarea;
export type { TextareaProps, TextareaVariant, TextareaSize };
