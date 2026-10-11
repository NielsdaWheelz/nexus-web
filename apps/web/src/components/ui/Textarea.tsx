"use client";

import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Field.module.css";

/**
 * A textarea. `autoGrow` fits its height to the content between `minRows` and
 * `maxRows` lines, then scrolls; it re-fits when the value or its width changes.
 */
export default function Textarea({
  bare = false,
  size = "md",
  autoGrow,
  className,
  rows,
  ref,
  ...rest
}: ComponentProps<"textarea"> & {
  bare?: boolean;
  size?: "sm" | "md" | "lg";
  autoGrow?: { minRows: number; maxRows: number };
}) {
  const element = useRef<HTMLTextAreaElement | null>(null);
  const maxRows = autoGrow?.maxRows;
  useLayoutEffect(() => {
    if (element.current && maxRows !== undefined) fit(element.current, maxRows);
  }, [maxRows, rest.value]);
  // A narrower pane rewraps the draft: re-fit when the width changes, a frame
  // later, so the new height is not a resize inside this observer's delivery.
  useLayoutEffect(() => {
    const textarea = element.current;
    if (!textarea || maxRows === undefined) return;
    let width = textarea.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit(textarea, maxRows));
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [maxRows]);

  return (
    <textarea
      ref={(node) => {
        element.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      rows={autoGrow?.minRows ?? rows}
      className={cx(
        styles.field,
        styles.textarea,
        styles[size],
        bare ? styles.bare : styles.boxed,
        autoGrow && styles.autoGrow,
        className,
      )}
      {...rest}
    />
  );
}

// Fits the height to the content, up to `maxRows` lines, then scrolls. Measured
// without a scrollbar, whose width would rewrap the text.
function fit(textarea: HTMLTextAreaElement, maxRows: number) {
  textarea.style.overflowY = "hidden";
  textarea.style.height = "auto";
  const style = getComputedStyle(textarea);
  const line = parseFloat(style.lineHeight);
  const padding =
    parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border =
    parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const content = textarea.scrollHeight;
  const limit = line > 0 ? line * maxRows + padding : Infinity;
  textarea.style.height = `${Math.min(content, limit) + border}px`;
  textarea.style.overflowY = content > limit ? "auto" : "hidden";
}
